/**
 * The deterministic correlation engine. Pure: (snapshot, pending transitions, now) → changes.
 *
 *  1. Dedupe   — each transition updates one AlertRecord (per alert rule + entity, or per node).
 *  2. Flapping — an entity with ≥ flapCount state changes in flapWindowMin joins one flap incident.
 *  3. Group    — a new problem joins an open incident at the same site when that incident is an
 *                ongoing outage or was active within windowSec, or one that already covers the node,
 *                or the incident of its upstream root (cross-site dependencies). Otherwise a new one.
 *  4. Classify — root cause via Orion dependencies / oriented topology / site WAN edge; kind, roles,
 *                title, template summary, deterministic priority.
 *  5. Lifecycle — hold-down auto-resolve, reopen, close, snooze expiry, maintenance flag.
 */
import { orionSeverity, SEVERITY_RANK } from '../orion';
import { maintenanceFor } from './calendar';
import { countStateChanges, rootOf, ROLE_RANK, type RootContext } from './graph';
import { effectivePriority } from '../ai/priority';
import { CORE_ROLES, scoreIncident } from './scoring';
import { incidentSummary, incidentTitle } from './templates';
import type {
  AlertRecord,
  CorrelationInput,
  CorrelationOutput,
  IncidentEventOut,
  IncidentKind,
  IncidentState,
  MemberRole,
  NodeInfo,
  RecordSeverity,
  StateChange,
  TransitionIn,
} from './types';

const OPEN = new Set(['open', 'acknowledged']);
const SOURCE_KEY = 'internal:source:swis';

export function dedupeKey(
  t: Pick<TransitionIn, 'kind' | 'nodeId' | 'alertObjectId' | 'details'>,
): string {
  if (t.kind === 'node') return `status:node:${t.nodeId}`;
  if (t.kind === 'source') return SOURCE_KEY;
  const alertId = t.details.alertId;
  const uri = t.details.entityUri;
  if (alertId !== undefined && typeof uri === 'string') return `${alertId}:${uri}`;
  return `alertobj:${t.alertObjectId}`;
}

/** Identity used for flap counting: the node or interface, so alert and status changes combine. */
export function flapKeyOf(r: Pick<AlertRecord, 'interfaceId' | 'nodeId' | 'key'>): string {
  if (r.interfaceId !== null) return `iface:${r.interfaceId}`;
  if (r.nodeId !== null) return `node:${r.nodeId}`;
  return `rec:${r.key}`;
}

export function flapKeyOfTransition(t: TransitionIn): string | null {
  if (t.kind === 'source') return null;
  if (t.interfaceId !== null) return `iface:${t.interfaceId}`;
  if (t.nodeId !== null) return `node:${t.nodeId}`;
  return t.kind === 'alert' ? `rec:${dedupeKey(t)}` : null;
}

/** Map a transition to a good/bad state change (or null when it is not a state change). */
export function stateChangeOf(t: TransitionIn): StateChange[] {
  if (t.details.initialSync || t.details.reconcile) return [];
  const at = t.observedAt;
  if (t.kind === 'alert') {
    if (t.change === 'raised') return [{ at, bad: true }];
    if (t.change === 'cleared') return [{ at, bad: false }];
    if (t.change === 'retriggered')
      return [
        { at: new Date(at.getTime() - 1), bad: false },
        { at, bad: true },
      ];
    return [];
  }
  if (t.kind === 'node' || t.kind === 'interface') {
    if (t.toState === 'down' || t.toState === 'unreachable' || t.toState === 'critical')
      return [{ at, bad: true }];
    if (t.toState === 'up') return [{ at, bad: false }];
  }
  return [];
}

const NODE_DOWN_ALERT = /\b(down|not responding|unreachable|offline)\b/i;

export function runCorrelation(input: CorrelationInput): CorrelationOutput {
  return new Engine(input).run();
}

class Engine {
  private readonly now: Date;
  private readonly records: Map<string, AlertRecord>;
  private readonly incidents = new Map<string, IncidentState>();
  private readonly touchedRecords = new Set<string>();
  private readonly touchedIncidents = new Set<string>();
  private readonly created = new Set<string>();
  private readonly reclassify = new Set<string>();
  private readonly material = new Set<string>();
  private readonly added = new Map<string, number>();
  private readonly events: IncidentEventOut[] = [];
  private readonly processed: number[] = [];
  private readonly changes: Map<string, StateChange[]>;
  private readonly upsRe: RegExp;
  private nextRef: number;
  private sourceReason: string | null = null;
  private readonly rootCtx: RootContext;
  private readonly firewallsBySite = new Map<number, number[]>();

  constructor(private readonly input: CorrelationInput) {
    this.now = input.now;
    for (const n of input.nodes.values()) {
      if (n.role === 'firewall' && n.siteId !== null && !n.unmanaged) {
        const list = this.firewallsBySite.get(n.siteId) ?? [];
        list.push(n.nodeId);
        this.firewallsBySite.set(n.siteId, list);
      }
    }
    this.rootCtx = {
      graph: input.graph,
      statusOf: (id) => input.nodes.get(id)?.statusNorm,
      isDown: (id) => this.isNodeDown(id),
      roleOf: (id) => input.nodes.get(id)?.role ?? 'other',
      siteFirewallDown: (id) => {
        const site = input.nodes.get(id)?.siteId;
        if (site == null) return null;
        return (this.firewallsBySite.get(site) ?? []).find((fw) => this.isNodeDown(fw)) ?? null;
      },
    };
    this.records = new Map([...input.records].map(([k, r]) => [k, { ...r }]));
    for (const i of input.incidents)
      this.incidents.set(i.ref, {
        ...i,
        members: new Map(i.members),
        affectedSiteIds: [...i.affectedSiteIds],
      });
    this.changes = new Map([...input.recentChanges].map(([k, v]) => [k, [...v]]));
    this.upsRe = new RegExp(input.config.upsAlertRegex, 'i');
    this.nextRef = input.nextRef ?? 1;
  }

  run(): CorrelationOutput {
    const cutoff = this.now.getTime() - this.input.config.maxAgeSec * 1000;
    const signals = new Set<string>();
    for (const t of this.input.transitions) {
      if (t.id !== null) this.processed.push(t.id);
      if (t.observedAt.getTime() < cutoff && !t.details.reconcile) continue; // stale backlog; reconcile covers current state
      const fk = flapKeyOfTransition(t);
      if (fk) {
        const list = this.changes.get(fk) ?? [];
        list.push(...stateChangeOf(t));
        this.changes.set(fk, list);
      }
      const key = this.apply(t);
      if (key) signals.add(key);
    }
    for (const key of signals) {
      const r = this.records.get(key);
      if (r?.state === 'active') this.assign(r);
    }
    // Active records with no incident (maintenance ended, or previously suppressed). A record
    // still attached to an incident someone resolved by hand stays there: only a new raise
    // (a signal above) reopens it, otherwise the next run would undo the person's decision.
    for (const r of this.records.values()) {
      if (r.state === 'active' && (r.incidentRef === null || r.suppressed) && !signals.has(r.key))
        this.assign(r);
    }
    this.repairUnknownSites();
    for (const ref of this.reclassify) this.classify(this.incidents.get(ref)!);
    for (const inc of this.incidents.values()) this.lifecycle(inc);
    for (const [ref, n] of this.added) {
      if (!this.created.has(ref) && n > 0) {
        this.event(ref, 'member_added', `${n} alert${n === 1 ? '' : 's'} added`);
      }
    }
    return {
      records: [...this.touchedRecords].map((k) => this.records.get(k)!),
      incidents: [...this.touchedIncidents].map((r) => this.incidents.get(r)!),
      events: this.events,
      processedTransitionIds: this.processed,
      materialChanges: [...this.material],
    };
  }

  // -------------------------------------------------------------------------------------------
  // 1. Dedupe
  // -------------------------------------------------------------------------------------------

  private newRecord(key: string, t: TransitionIn, init: Partial<AlertRecord>): AlertRecord {
    const at = t.sourceAt ?? t.observedAt;
    return {
      key,
      source: 'orion',
      alertId: null,
      alertName: 'Alert',
      entityUri: null,
      entityType: null,
      entityCaption: null,
      nodeId: t.nodeId,
      interfaceId: t.interfaceId,
      siteId:
        t.siteId ?? (t.nodeId !== null ? (this.input.nodes.get(t.nodeId)?.siteId ?? null) : null),
      severity: 'none',
      state: 'cleared',
      firstSeenAt: at,
      lastSeenAt: t.observedAt,
      lastRaisedAt: at,
      clearedAt: null,
      triggerCount: 0,
      currentAlertObjectId: null,
      currentAlertActiveId: null,
      lastMessage: null,
      acknowledgedInOrion: false,
      incidentRef: null,
      suppressed: false,
      seeded: !!(t.details.initialSync || t.details.reconcile),
      ...init,
    };
  }

  private raise(r: AlertRecord, t: TransitionIn): void {
    const wasActive = r.state === 'active';
    r.state = 'active';
    r.clearedAt = null;
    r.lastSeenAt = t.observedAt;
    if (!wasActive || t.change === 'retriggered') {
      r.lastRaisedAt = t.sourceAt ?? t.observedAt;
      r.triggerCount += 1;
    }
    if (r.triggerCount > 1 && !(t.details.initialSync || t.details.reconcile)) r.seeded = false;
    this.downByAlert = null;
    r.siteId =
      t.siteId ??
      r.siteId ??
      (r.nodeId !== null ? (this.input.nodes.get(r.nodeId)?.siteId ?? null) : null);
    this.touchedRecords.add(r.key);
  }

  private clear(r: AlertRecord, t: TransitionIn): void {
    if (r.state !== 'active') return;
    r.state = 'cleared';
    this.downByAlert = null;
    r.clearedAt = t.observedAt;
    r.lastSeenAt = t.observedAt;
    this.touchedRecords.add(r.key);
    if (r.incidentRef && this.incidents.has(r.incidentRef)) this.reclassify.add(r.incidentRef);
  }

  /** Returns the record key when the transition makes something newly (or again) active. */
  private apply(t: TransitionIn): string | null {
    const key = dedupeKey(t);
    let r = this.records.get(key);
    if (t.kind === 'alert') {
      const d = t.details;
      if (t.change === 'raised' || t.change === 'retriggered') {
        r ??= this.newRecord(key, t, {});
        this.records.set(key, r);
        r.source = 'orion';
        r.alertId = typeof d.alertId === 'number' ? d.alertId : r.alertId;
        r.alertName = typeof d.alertName === 'string' ? d.alertName : r.alertName;
        r.entityUri = typeof d.entityUri === 'string' ? d.entityUri : r.entityUri;
        r.entityType = typeof d.entityType === 'string' ? d.entityType : r.entityType;
        r.entityCaption = typeof d.entityCaption === 'string' ? d.entityCaption : r.entityCaption;
        r.severity = typeof d.severity === 'number' ? orionSeverity(d.severity) : r.severity;
        r.lastMessage = typeof d.message === 'string' ? d.message : r.lastMessage;
        r.currentAlertObjectId = t.alertObjectId;
        r.currentAlertActiveId = t.alertActiveId;
        r.nodeId = t.nodeId ?? r.nodeId;
        r.interfaceId = t.interfaceId ?? r.interfaceId;
        this.raise(r, t);
        return key;
      }
      if (!r) return null;
      if (t.change === 'cleared') this.clear(r, t);
      else if (t.change === 'acked' || t.change === 'unacked') {
        r.acknowledgedInOrion = t.change === 'acked';
        this.touchedRecords.add(key);
      }
      return null;
    }
    if (t.kind === 'node' && t.nodeId !== null) {
      const caption =
        typeof t.details.caption === 'string'
          ? t.details.caption
          : (this.input.nodes.get(t.nodeId)?.caption ?? `node ${t.nodeId}`);
      if (t.toState === 'down' || t.toState === 'unreachable') {
        r ??= this.newRecord(key, t, {});
        this.records.set(key, r);
        r.source = 'status';
        r.alertName =
          t.toState === 'down' ? 'Node down (Orion status)' : 'Node unreachable (Orion status)';
        r.entityType = 'Orion.Nodes';
        r.entityCaption = caption;
        r.severity = t.toState === 'down' ? 'critical' : 'none';
        r.lastMessage =
          typeof t.details.statusDescription === 'string' ? t.details.statusDescription : null;
        this.raise(r, t);
        return key;
      }
      if (r) this.clear(r, t);
      return null;
    }
    if (t.kind === 'source') {
      if (t.toState === 'down') {
        r ??= this.newRecord(key, t, {});
        this.records.set(key, r);
        r.source = 'internal';
        r.alertName = 'SolarWinds monitoring unavailable';
        r.entityCaption = 'SolarWinds SWIS';
        r.severity = 'critical';
        r.siteId = null;
        r.nodeId = null;
        r.lastMessage = typeof t.details.reason === 'string' ? t.details.reason : null;
        this.sourceReason = r.lastMessage;
        this.raise(r, t);
        return key;
      }
      if (r) this.clear(r, t);
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // 2–3. Flapping and grouping
  // -------------------------------------------------------------------------------------------

  /** Nodes with an active node-level down alert (cached; invalidated when records change). */
  private downByAlert: Set<number> | null = null;

  private isNodeDown(nodeId: number): boolean {
    if (this.input.nodes.get(nodeId)?.statusNorm === 'down') return true;
    if (!this.downByAlert) {
      // An Orion node-down alert can arrive one node poll before the status changes.
      this.downByAlert = new Set();
      for (const r of this.records.values()) {
        if (
          r.state !== 'active' ||
          r.nodeId === null ||
          r.interfaceId !== null ||
          r.source === 'internal'
        )
          continue;
        if (r.source === 'status' ? r.severity === 'critical' : NODE_DOWN_ALERT.test(r.alertName))
          this.downByAlert.add(r.nodeId);
      }
    }
    return this.downByAlert.has(nodeId);
  }

  private flapping(r: AlertRecord): { flapping: boolean; key: string; count: number } {
    const key = flapKeyOf(r);
    const count = countStateChanges(
      this.changes.get(key) ?? [],
      this.now,
      this.input.config.flapWindowMin,
    );
    return {
      flapping: r.source !== 'internal' && count >= this.input.config.flapCount,
      key,
      count,
    };
  }

  private assign(r: AlertRecord): void {
    const cfg = this.input.config;
    const cur = r.incidentRef ? this.incidents.get(r.incidentRef) : undefined;
    const maint =
      r.source === 'internal'
        ? null
        : maintenanceFor(
            this.input.maintenance,
            { nodeId: r.nodeId, siteId: r.siteId },
            this.now,
            cfg.timezone,
          );
    if (maint?.suppress === 'incidents' && !(cur && OPEN.has(cur.status))) {
      if (!r.suppressed) {
        r.suppressed = true;
        this.touchedRecords.add(r.key);
      }
      return;
    }
    if (r.suppressed) {
      r.suppressed = false;
      this.touchedRecords.add(r.key);
    }

    const flap = this.flapping(r);
    if (flap.flapping) {
      const flapKey = `flap:${flap.key}`;
      let target = [...this.incidents.values()].find(
        (i) => i.correlationKey === flapKey && OPEN.has(i.status),
      );
      const reusable =
        cur &&
        (OPEN.has(cur.status) || this.withinReopen(cur)) &&
        cur.kind !== 'monitoring_source_down' &&
        [...cur.members.keys()].every((k) => {
          const m = this.records.get(k);
          return !m || flapKeyOf(m) === flap.key;
        });
      if (!target && reusable) {
        target = cur;
        if (!OPEN.has(cur.status)) this.reopen(cur);
        if (cur.correlationKey !== flapKey) {
          cur.correlationKey = flapKey;
          this.touchedIncidents.add(cur.ref);
        }
      }
      target ??= this.create(flapKey);
      if (cur && cur !== target && OPEN.has(cur.status)) this.detach(cur, r);
      this.attach(target, r);
      return;
    }

    if (cur && OPEN.has(cur.status)) {
      this.touch(cur, r);
      return;
    }
    if (cur && this.withinReopen(cur)) {
      this.reopen(cur);
      this.touch(cur, r);
      return;
    }

    if (r.source === 'internal') {
      const inc = [...this.incidents.values()].find(
        (i) => i.correlationKey === 'source:swis' && OPEN.has(i.status),
      );
      this.attach(inc ?? this.create('source:swis'), r);
      return;
    }

    const windowMs = cfg.windowSec * 1000;
    const root = r.nodeId !== null ? rootOf(r.nodeId, this.rootCtx) : null;
    let best: IncidentState | undefined;
    for (const inc of this.incidents.values()) {
      if (
        !OPEN.has(inc.status) ||
        inc.correlationKey.startsWith('flap:') ||
        inc.correlationKey === 'source:swis'
      )
        continue;
      const recent = this.now.getTime() - inc.lastActivityAt.getTime() <= windowMs;
      const sameSite =
        r.siteId !== null &&
        (inc.primarySiteId === r.siteId || inc.affectedSiteIds.includes(r.siteId));
      // An ongoing outage absorbs its symptoms whenever they arrive; anything else only within
      // the window — an old standing alert on the same device must not swallow a new storm.
      const outageRoot =
        inc.rootNodeId !== null &&
        (inc.kind === 'site_outage' || inc.kind === 'device_down') &&
        this.isNodeDown(inc.rootNodeId)
          ? inc.rootNodeId
          : null;
      const symptomOfOutage = outageRoot !== null && root === outageRoot;
      const sameNodeNoSite =
        r.siteId === null && r.nodeId !== null && this.hasMemberOnNode(inc, r.nodeId) && recent;
      if ((sameSite && recent) || symptomOfOutage || sameNodeNoSite) {
        if (!best || inc.lastActivityAt > best.lastActivityAt) best = inc;
      }
    }
    if (!best) {
      const scope =
        r.siteId !== null
          ? `site:${r.siteId}`
          : r.nodeId !== null
            ? `node:${r.nodeId}`
            : `rec:${r.key}`;
      best = this.create(`${scope}:${this.now.getTime()}`);
    }
    this.attach(best, r);
  }

  /**
   * Alerts correlated before the node mirror was populated (first start) have no site. Fill it in
   * once node data exists and reclassify those incidents so site, tier and priority are right.
   */
  private repairUnknownSites(): void {
    for (const r of this.records.values()) {
      if (r.siteId !== null || r.nodeId === null) continue;
      const site = this.input.nodes.get(r.nodeId)?.siteId ?? null;
      if (site === null) continue;
      r.siteId = site;
      this.touchedRecords.add(r.key);
      if (r.incidentRef && this.incidents.has(r.incidentRef)) this.reclassify.add(r.incidentRef);
    }
    for (const inc of this.incidents.values()) {
      if (
        !OPEN.has(inc.status) ||
        inc.primarySiteId !== null ||
        inc.correlationKey === 'source:swis'
      )
        continue;
      const known = [...inc.members.keys()].some((k) => {
        const m = this.records.get(k);
        return m?.nodeId != null && this.input.nodes.get(m.nodeId)?.siteId != null;
      });
      if (known) this.reclassify.add(inc.ref);
    }
  }

  private hasMemberOnNode(inc: IncidentState, nodeId: number): boolean {
    for (const k of inc.members.keys()) if (this.records.get(k)?.nodeId === nodeId) return true;
    return false;
  }

  private withinReopen(inc: IncidentState): boolean {
    return (
      inc.status === 'resolved' &&
      inc.resolvedAt !== null &&
      this.now.getTime() - inc.resolvedAt.getTime() <= this.input.config.reopenWindowSec * 1000
    );
  }

  private create(correlationKey: string): IncidentState {
    const ref = `new:${this.nextRef++}`;
    const inc: IncidentState = {
      ref,
      status: 'open',
      kind: 'generic',
      correlationKey,
      title: 'New incident',
      templateSummary: '',
      priority: 'P4',
      basePriority: 'P4',
      baseScore: 0,
      priorityFactors: {
        impact: 'informational',
        impactPoints: 0,
        severity: 'none',
        severityWeight: 0,
        tier: null,
        tierMult: 1,
        season: null,
        seasonMult: 1,
        businessHours: true,
        timeMult: 1,
        score: 0,
        explanation: [],
      },
      primarySiteId: null,
      divisionCodes: [],
      affectedSiteIds: [],
      rootNodeId: null,
      rootEntityUri: null,
      recoveryTargetMin: this.input.config.scoring.recoveryDefaultMin,
      openedAt: this.now,
      lastActivityAt: this.now,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvePendingSince: null,
      resolvedAt: null,
      resolvedBy: null,
      closedAt: null,
      snoozedUntil: null,
      alertCount: 0,
      memberCount: 0,
      materialRev: 0,
      inMaintenance: false,
      seeded: true,
      aiPriorityAdjust: null,
      aiPriorityBasis: null,
      members: new Map(),
    };
    this.incidents.set(ref, inc);
    this.created.add(ref);
    this.touchedIncidents.add(ref);
    this.reclassify.add(ref);
    return inc;
  }

  private attach(inc: IncidentState, r: AlertRecord): void {
    if (!inc.members.has(r.key)) {
      inc.members.set(r.key, 'member');
      this.added.set(inc.ref, (this.added.get(inc.ref) ?? 0) + 1);
      // An incident is "seeded" (pre-existing at startup) only if every member was.
      if (!r.seeded) inc.seeded = false;
    }
    r.incidentRef = inc.ref;
    // Provisional site until classification runs, so later signals in the same batch can match it.
    if (r.siteId !== null) {
      inc.primarySiteId ??= r.siteId;
      if (!inc.affectedSiteIds.includes(r.siteId)) inc.affectedSiteIds.push(r.siteId);
    }
    this.touchedRecords.add(r.key);
    this.touch(inc, r);
  }

  private touch(inc: IncidentState, _r: AlertRecord): void {
    inc.lastActivityAt = this.now;
    inc.resolvePendingSince = null;
    this.touchedIncidents.add(inc.ref);
    this.reclassify.add(inc.ref);
  }

  private detach(inc: IncidentState, r: AlertRecord): void {
    inc.members.delete(r.key);
    this.touchedIncidents.add(inc.ref);
    this.reclassify.add(inc.ref);
    if (inc.members.size === 0) {
      inc.status = 'closed';
      inc.closedAt = this.now;
      inc.resolvedAt ??= this.now;
      inc.resolvedBy = 'merged';
      this.event(inc.ref, 'merged', 'Merged into a flapping incident');
    }
  }

  private reopen(inc: IncidentState): void {
    inc.status = 'open';
    inc.resolvedAt = null;
    inc.resolvedBy = null;
    inc.closedAt = null;
    inc.resolvePendingSince = null;
    inc.materialRev += 1;
    this.material.add(inc.ref);
    this.touchedIncidents.add(inc.ref);
    this.event(inc.ref, 'reopened', 'Problem returned within the reopen window');
  }

  // -------------------------------------------------------------------------------------------
  // 4. Classification and scoring
  // -------------------------------------------------------------------------------------------

  private classify(inc: IncidentState): void {
    if (inc.status === 'closed') return;
    const members = [...inc.members.keys()]
      .map((k) => this.records.get(k))
      .filter((r): r is AlertRecord => !!r);
    const active = members
      .filter((r) => r.state === 'active')
      .sort(
        (a, b) =>
          (b.severity === 'none' ? -1 : SEVERITY_RANK[b.severity]) -
            (a.severity === 'none' ? -1 : SEVERITY_RANK[a.severity]) ||
          b.lastRaisedAt.getTime() - a.lastRaisedAt.getTime(),
      );
    inc.alertCount = members.filter((r) => r.source === 'orion').length;
    inc.memberCount = members.length;
    this.touchedIncidents.add(inc.ref);
    if (!active.length) return; // keep the last classification while it resolves

    const nodes = this.input.nodes;
    const involved = [
      ...new Set(active.map((r) => r.nodeId).filter((n): n is number => n !== null)),
    ];
    const down = involved.filter((n) => this.isNodeDown(n));
    const unreachable = involved.filter(
      (n) => !down.includes(n) && nodes.get(n)?.statusNorm === 'unreachable',
    );

    // Root: the most upstream down device among the members' roots.
    let rootNodeId: number | null = null;
    for (const n of involved) {
      const r = rootOf(n, this.rootCtx);
      if (r === null) continue;
      if (
        rootNodeId === null ||
        ROLE_RANK[nodes.get(r)?.role ?? 'other'] > ROLE_RANK[nodes.get(rootNodeId)?.role ?? 'other']
      ) {
        rootNodeId = r;
      }
    }

    const siteCounts = new Map<number, number>();
    for (const r of active)
      if (r.siteId !== null) siteCounts.set(r.siteId, (siteCounts.get(r.siteId) ?? 0) + 1);
    const rootSite = rootNodeId !== null ? (nodes.get(rootNodeId)?.siteId ?? null) : null;
    const primarySiteId =
      rootSite ??
      [...siteCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      inc.primarySiteId;
    const affected = new Set<number>(
      members.map((r) => r.siteId).filter((s): s is number => s !== null),
    );
    if (primarySiteId !== null) affected.add(primarySiteId);

    let kind: IncidentKind;
    const siteNodes =
      primarySiteId !== null
        ? [...nodes.values()].filter((n) => n.siteId === primarySiteId && !n.unmanaged)
        : [];
    if (inc.correlationKey === 'source:swis') kind = 'monitoring_source_down';
    else if (inc.correlationKey.startsWith('flap:')) kind = 'flapping';
    else if (
      rootNodeId !== null &&
      nodes.get(rootNodeId)?.role === 'firewall' &&
      this.isNodeDown(rootNodeId) &&
      nodes.get(rootNodeId)?.siteId === primarySiteId
    )
      kind = 'site_outage';
    else if (
      siteNodes.length >= 2 &&
      siteNodes.every((n) => this.isNodeDown(n.nodeId) || n.statusNorm === 'unreachable')
    )
      kind = 'site_outage';
    else if (
      active.some(
        (r) =>
          (r.nodeId !== null && nodes.get(r.nodeId)?.role === 'ups') ||
          this.upsRe.test(r.alertName),
      )
    )
      kind = 'ups_power';
    else if (down.length || unreachable.length) kind = 'device_down';
    else if (active.every((r) => r.interfaceId !== null)) kind = 'interface';
    else if (active.some((r) => /application|apm|component|service/i.test(r.entityType ?? '')))
      kind = 'service';
    else kind = 'generic';

    // Member roles.
    for (const r of members) {
      let role: MemberRole = 'member';
      if (rootNodeId !== null && r.nodeId === rootNodeId && r.interfaceId === null) role = 'root';
      else if (
        rootNodeId !== null &&
        r.nodeId !== null &&
        (rootOf(r.nodeId, this.rootCtx) === rootNodeId ||
          (kind === 'site_outage' && r.siteId === primarySiteId))
      )
        role = 'symptom';
      inc.members.set(r.key, role);
    }

    let severity: RecordSeverity = 'none';
    for (const r of active) {
      if (
        r.severity !== 'none' &&
        (severity === 'none' || SEVERITY_RANK[r.severity] > SEVERITY_RANK[severity])
      )
        severity = r.severity;
    }
    const site = primarySiteId !== null ? (this.input.sites.get(primarySiteId) ?? null) : null;
    const downNodes = down.map((n) => nodes.get(n)).filter((n): n is NodeInfo => !!n);
    const unreachableNodes = unreachable.map((n) => nodes.get(n)).filter((n): n is NodeInfo => !!n);
    const scored = scoreIncident({
      kind,
      downRoles: downNodes.map((n) => n.role),
      affectedNodes: down.length + unreachable.length,
      interfaceOnCoreRole: active.some(
        (r) =>
          r.interfaceId !== null &&
          r.nodeId !== null &&
          CORE_ROLES.has(nodes.get(r.nodeId)?.role ?? 'other'),
      ),
      firewallDown: downNodes.some((n) => n.role === 'firewall'),
      severity,
      site,
      seasons: this.input.seasons,
      now: this.now,
      timeZone: this.input.config.timezone,
      cfg: this.input.config.scoring,
    });
    const flapKey = inc.correlationKey.startsWith('flap:') ? inc.correlationKey.slice(5) : null;
    const rootNode =
      rootNodeId !== null
        ? (nodes.get(rootNodeId) ?? null)
        : flapKey?.startsWith('node:')
          ? (nodes.get(Number(flapKey.slice(5))) ?? null)
          : null;
    const tpl = {
      kind,
      site,
      rootNode,
      downNodes,
      unreachableNodes,
      activeRecords: active,
      alertCount: inc.alertCount,
      flapChanges: flapKey
        ? countStateChanges(
            this.changes.get(flapKey) ?? [],
            this.now,
            this.input.config.flapWindowMin,
          )
        : 0,
      flapWindowMin: this.input.config.flapWindowMin,
      harvestCriticalInHarvest: scored.harvestCriticalInHarvest,
      recoveryTargetMin: scored.recoveryTargetMin,
      sourceReason:
        kind === 'monitoring_source_down' ? (active[0]?.lastMessage ?? this.sourceReason) : null,
    };

    const before = {
      kind: inc.kind,
      priority: inc.priority,
      root: inc.rootNodeId,
      sites: [...inc.affectedSiteIds].sort().join(','),
    };
    inc.kind = kind;
    inc.rootNodeId = rootNodeId;
    inc.rootEntityUri =
      rootNodeId !== null ? (active.find((r) => r.nodeId === rootNodeId)?.entityUri ?? null) : null;
    inc.primarySiteId = primarySiteId;
    if (site?.divisionCodes.length) inc.divisionCodes = [...site.divisionCodes];
    inc.affectedSiteIds = [...affected].sort((a, b) => a - b);
    inc.baseScore = scored.score;
    inc.basePriority = scored.priority;
    // A stored AI adjustment holds only while kind and base priority are what it was made for;
    // otherwise priority follows the score until the AI job looks again.
    inc.priority = effectivePriority(scored.priority, kind, inc, {
      firewallDown: downNodes.some((n) => n.role === 'firewall'),
      harvestCriticalInHarvest: scored.harvestCriticalInHarvest,
    });
    inc.priorityFactors = scored.factors;
    inc.recoveryTargetMin = scored.recoveryTargetMin;
    inc.title = incidentTitle(tpl);
    inc.templateSummary = incidentSummary(tpl);

    if (this.created.has(inc.ref)) {
      this.material.add(inc.ref);
      return;
    }
    const after = {
      kind,
      priority: inc.priority,
      root: rootNodeId,
      sites: inc.affectedSiteIds.join(','),
    };
    if (
      before.kind !== after.kind ||
      before.root !== after.root ||
      before.sites !== after.sites ||
      before.priority !== after.priority
    ) {
      inc.materialRev += 1;
      this.material.add(inc.ref);
      if (before.kind !== after.kind)
        this.event(inc.ref, 'kind_changed', `Now: ${inc.title}`, { from: before.kind, to: kind });
      if (before.priority !== after.priority)
        this.event(inc.ref, 'priority_changed', `Priority ${before.priority} → ${after.priority}`, {
          from: before.priority,
          to: after.priority,
          explanation: scored.factors.explanation,
        });
    }
  }

  // -------------------------------------------------------------------------------------------
  // 5. Lifecycle
  // -------------------------------------------------------------------------------------------

  private lifecycle(inc: IncidentState): void {
    const cfg = this.input.config;
    const now = this.now.getTime();
    if (this.created.has(inc.ref)) {
      this.event(inc.ref, 'opened', `${inc.priority} · ${inc.title}`, {
        priority: inc.priority,
        kind: inc.kind,
        explanation: inc.priorityFactors.explanation,
        seeded: inc.seeded,
      });
    }
    if (OPEN.has(inc.status)) {
      const anyActive = [...inc.members.keys()].some(
        (k) => this.records.get(k)?.state === 'active',
      );
      const holdMs = (inc.kind === 'flapping' ? cfg.flapWindowMin * 60 : cfg.holddownSec) * 1000;
      if (anyActive) {
        if (inc.resolvePendingSince) {
          inc.resolvePendingSince = null;
          this.touchedIncidents.add(inc.ref);
        }
      } else if (!inc.resolvePendingSince) {
        inc.resolvePendingSince = this.now;
        this.touchedIncidents.add(inc.ref);
        if (holdMs === 0) this.resolve(inc);
      } else if (now - inc.resolvePendingSince.getTime() >= holdMs) {
        this.resolve(inc);
      }
      const m = maintenanceFor(
        this.input.maintenance,
        { nodeId: inc.rootNodeId, siteId: inc.primarySiteId },
        this.now,
        cfg.timezone,
      );
      const inMaint = inc.kind !== 'monitoring_source_down' && !!m;
      if (inMaint !== inc.inMaintenance) {
        inc.inMaintenance = inMaint;
        this.touchedIncidents.add(inc.ref);
      }
    }
    if (
      inc.status === 'resolved' &&
      inc.resolvedAt &&
      now - inc.resolvedAt.getTime() > cfg.reopenWindowSec * 1000
    ) {
      inc.status = 'closed';
      inc.closedAt = this.now;
      this.touchedIncidents.add(inc.ref);
      this.event(inc.ref, 'closed', 'Closed (no recurrence within the reopen window)');
    }
    if (inc.snoozedUntil && now >= inc.snoozedUntil.getTime()) {
      inc.snoozedUntil = null;
      this.touchedIncidents.add(inc.ref);
      this.event(inc.ref, 'snooze_expired', 'Snooze ended');
    }
  }

  private resolve(inc: IncidentState): void {
    inc.status = 'resolved';
    inc.resolvedAt = this.now;
    inc.resolvedBy = 'auto';
    inc.resolvePendingSince = null;
    inc.materialRev += 1;
    this.material.add(inc.ref);
    this.touchedIncidents.add(inc.ref);
    this.event(
      inc.ref,
      'resolved',
      'All alerts cleared and stayed clear through the hold-down period',
    );
  }

  private event(
    ref: string,
    type: IncidentEventOut['type'],
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.events.push({ incidentRef: ref, at: this.now, type, actor: 'system', message, details });
  }
}
