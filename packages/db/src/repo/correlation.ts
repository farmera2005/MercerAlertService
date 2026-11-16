import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import {
  buildTopologyGraph,
  chunk,
  dedupeKey,
  flapKeyOfTransition,
  isDeviceRole,
  stateChangeOf,
  type AlertRecord,
  type CorrelationConfig,
  type CorrelationInput,
  type CorrelationOutput,
  type IncidentState,
  type MaintenanceWindow,
  type MemberRole,
  type NodeInfo,
  type RecordSeverity,
  type SeasonPeriod,
  type SiteInfo,
  type StateChange,
  type StatusNorm,
  type TransitionIn,
} from '@mercer/core';
import {
  alertRecords,
  divisions,
  entityTransitions,
  incidentEvents,
  incidentMembers,
  incidents,
  maintenanceWindows,
  orionActiveAlerts,
  orionDependencies,
  orionGroupMembers,
  orionNodes,
  seasonPeriods,
  sites,
  topologyConnections,
} from '../schema';
import type { DbOrTx, Tx } from '../client';
import { inSequence } from './helpers';

type IncidentRow = typeof incidents.$inferSelect;
type RecordRow = typeof alertRecords.$inferSelect;
type TransitionRow = typeof entityTransitions.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------------------------

function toRecord(r: RecordRow): AlertRecord {
  return {
    key: r.dedupeKey,
    id: r.id,
    source: r.source as AlertRecord['source'],
    alertId: r.alertId,
    alertName: r.alertName,
    entityUri: r.entityUri,
    entityType: r.entityType,
    entityCaption: r.entityCaption,
    nodeId: r.nodeId,
    interfaceId: r.interfaceId,
    siteId: r.siteId,
    severity: r.severity as RecordSeverity,
    state: r.state,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    lastRaisedAt: r.lastRaisedAt,
    clearedAt: r.clearedAt,
    triggerCount: r.triggerCount,
    currentAlertObjectId: r.currentAlertObjectId,
    currentAlertActiveId: r.currentAlertActiveId,
    lastMessage: r.lastMessage,
    acknowledgedInOrion: r.acknowledgedInOrion,
    incidentRef: r.incidentId ? `id:${r.incidentId}` : null,
    suppressed: r.suppressed,
    seeded: r.seeded,
  };
}

function toIncident(r: IncidentRow, members: Map<string, MemberRole>): IncidentState {
  return {
    ref: `id:${r.id}`,
    id: r.id,
    status: r.status,
    kind: r.kind,
    correlationKey: r.correlationKey,
    title: r.title,
    templateSummary: r.templateSummary,
    priority: r.priority,
    basePriority: r.basePriority,
    baseScore: r.baseScore,
    priorityFactors: r.priorityFactors,
    primarySiteId: r.primarySiteId,
    divisionCode: r.divisionCode,
    affectedSiteIds: r.affectedSiteIds,
    rootNodeId: r.rootNodeId,
    rootEntityUri: r.rootEntityUri,
    recoveryTargetMin: r.recoveryTargetMin,
    openedAt: r.openedAt,
    lastActivityAt: r.lastActivityAt,
    acknowledgedAt: r.acknowledgedAt,
    acknowledgedBy: r.acknowledgedBy,
    resolvePendingSince: r.resolvePendingSince,
    resolvedAt: r.resolvedAt,
    resolvedBy: r.resolvedBy,
    closedAt: r.closedAt,
    snoozedUntil: r.snoozedUntil,
    alertCount: r.alertCount,
    memberCount: r.memberCount,
    materialRev: r.materialRev,
    inMaintenance: r.inMaintenance,
    seeded: r.seeded,
    aiPriorityAdjust: r.aiPriorityAdjust,
    members,
  };
}

function incidentValues(i: IncidentState) {
  return {
    status: i.status,
    kind: i.kind,
    correlationKey: i.correlationKey,
    title: i.title,
    templateSummary: i.templateSummary,
    priority: i.priority,
    basePriority: i.basePriority,
    baseScore: i.baseScore,
    priorityFactors: i.priorityFactors,
    primarySiteId: i.primarySiteId,
    divisionCode: i.divisionCode,
    affectedSiteIds: i.affectedSiteIds,
    rootNodeId: i.rootNodeId,
    rootEntityUri: i.rootEntityUri,
    recoveryTargetMin: i.recoveryTargetMin,
    openedAt: i.openedAt,
    lastActivityAt: i.lastActivityAt,
    acknowledgedAt: i.acknowledgedAt,
    acknowledgedBy: i.acknowledgedBy,
    resolvePendingSince: i.resolvePendingSince,
    resolvedAt: i.resolvedAt,
    resolvedBy: i.resolvedBy,
    closedAt: i.closedAt,
    snoozedUntil: i.snoozedUntil,
    alertCount: i.alertCount,
    memberCount: i.memberCount,
    materialRev: i.materialRev,
    inMaintenance: i.inMaintenance,
    seeded: i.seeded,
    updatedAt: new Date(),
  };
}

export function toTransition(t: TransitionRow): TransitionIn {
  return {
    id: t.id,
    kind: t.kind,
    change: t.change,
    entityKey: t.entityKey,
    nodeId: t.nodeId,
    interfaceId: t.interfaceId,
    siteId: t.siteId,
    alertObjectId: t.alertObjectId,
    alertActiveId: t.alertActiveId,
    fromState: t.fromState,
    toState: t.toState,
    observedAt: t.observedAt,
    sourceAt: t.sourceAt,
    details: t.details,
  };
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

export async function loadPendingTransitions(db: DbOrTx, limit = 2000): Promise<TransitionIn[]> {
  const rows = await db
    .select()
    .from(entityTransitions)
    .where(isNull(entityTransitions.correlatedAt))
    .orderBy(asc(entityTransitions.id))
    .limit(limit);
  return rows.map(toTransition);
}

export async function countPendingTransitions(db: DbOrTx): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(entityTransitions)
    .where(isNull(entityTransitions.correlatedAt));
  return r?.n ?? 0;
}

/** Everything the engine needs besides the transitions. Run inside the correlation transaction. */
export async function loadCorrelationSnapshot(
  db: DbOrTx,
  opts: { now: Date; config: CorrelationConfig; transitions: TransitionIn[] },
): Promise<CorrelationInput> {
  const { now, config } = opts;
  const [nodeRows, siteRows, depRows, memberRows, connRows, seasonRows, maintRows] =
    await inSequence([
      db
        .select({
          nodeId: orionNodes.nodeId,
          caption: orionNodes.caption,
          siteId: orionNodes.siteId,
          role: orionNodes.deviceRole,
          statusNorm: orionNodes.statusNorm,
          unmanaged: orionNodes.unmanaged,
        })
        .from(orionNodes)
        .where(isNull(orionNodes.removedAt)),
      db
        .select({ site: sites, divisionName: divisions.name })
        .from(sites)
        .leftJoin(divisions, eq(divisions.code, sites.divisionCode)),
      db.select().from(orionDependencies),
      db
        .select({ containerId: orionGroupMembers.containerId, nodeId: orionGroupMembers.nodeId })
        .from(orionGroupMembers),
      db
        .select({
          srcNodeId: topologyConnections.srcNodeId,
          destNodeId: topologyConnections.destNodeId,
        })
        .from(topologyConnections),
      db.select().from(seasonPeriods).where(eq(seasonPeriods.enabled, true)),
      db
        .select()
        .from(maintenanceWindows)
        .where(
          or(
            isNull(maintenanceWindows.endsAt),
            gte(maintenanceWindows.endsAt, new Date(now.getTime() - 86_400_000)),
          ),
        ),
    ]);

  const nodes = new Map<number, NodeInfo>(
    nodeRows.map((n) => [
      n.nodeId,
      {
        nodeId: n.nodeId,
        caption: n.caption,
        siteId: n.siteId,
        role: isDeviceRole(n.role) ? n.role : 'other',
        statusNorm: n.statusNorm as StatusNorm,
        unmanaged: n.unmanaged,
      },
    ]),
  );
  const siteMap = new Map<number, SiteInfo>(
    siteRows.map(({ site: s, divisionName }) => [
      s.id,
      {
        id: s.id,
        name: s.name,
        divisionCode: s.divisionCode,
        divisionName,
        tier: s.tier,
        harvestCritical: s.harvestCritical,
        businessHours: s.businessHours,
        harvestHours: s.harvestHours ?? null,
      },
    ]),
  );
  const groups = new Map<number, number[]>();
  for (const m of memberRows) {
    if (m.nodeId === null) continue;
    const list = groups.get(m.containerId) ?? [];
    list.push(m.nodeId);
    groups.set(m.containerId, list);
  }
  const graph = buildTopologyGraph({
    dependencies: depRows,
    groupMembers: groups,
    connections: connRows,
    roles: new Map([...nodes].map(([id, n]) => [id, n.role])),
  });
  const seasons: SeasonPeriod[] = seasonRows.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    startMd: s.startMd,
    endMd: s.endMd,
    year: s.year,
    multiplier: s.multiplier,
    divisions: s.divisions,
    harvestCriticalOnly: s.harvestCriticalOnly,
    enabled: s.enabled,
  }));
  const maintenance: MaintenanceWindow[] = maintRows.map((m) => ({
    id: m.id,
    scope: m.scope,
    siteId: m.siteId,
    nodeId: m.nodeId,
    startsAt: m.startsAt,
    endsAt: m.endsAt,
    recurrence: m.recurrence ?? null,
    suppress: m.suppress,
    reason: m.reason,
  }));

  // Incidents still in play: open/acknowledged, or resolved within the reopen window.
  const reopenSince = new Date(now.getTime() - config.reopenWindowSec * 1000);
  const incRows = await db
    .select()
    .from(incidents)
    .where(
      or(
        inArray(incidents.status, ['open', 'acknowledged']),
        and(eq(incidents.status, 'resolved'), gte(incidents.resolvedAt, reopenSince)),
      ),
    );
  const incIds = incRows.map((i) => i.id);
  const memberRowsAll = incIds.length
    ? await db
        .select({
          incidentId: incidentMembers.incidentId,
          role: incidentMembers.role,
          record: alertRecords,
        })
        .from(incidentMembers)
        .innerJoin(alertRecords, eq(alertRecords.id, incidentMembers.alertRecordId))
        .where(inArray(incidentMembers.incidentId, incIds))
    : [];
  const membersByIncident = new Map<number, Map<string, MemberRole>>();
  const records = new Map<string, AlertRecord>();
  for (const m of memberRowsAll) {
    let map = membersByIncident.get(m.incidentId);
    if (!map) membersByIncident.set(m.incidentId, (map = new Map()));
    map.set(m.record.dedupeKey, m.role);
    records.set(m.record.dedupeKey, toRecord(m.record));
  }
  const loadedIncidents = incRows.map((r) =>
    toIncident(r, membersByIncident.get(r.id) ?? new Map()),
  );

  const active = await db.select().from(alertRecords).where(eq(alertRecords.state, 'active'));
  for (const r of active) records.set(r.dedupeKey, toRecord(r));
  const wanted = [...new Set(opts.transitions.map((t) => dedupeKey(t)))].filter(
    (k) => !records.has(k),
  );
  for (const part of chunk(wanted, 1000)) {
    const rows = await db.select().from(alertRecords).where(inArray(alertRecords.dedupeKey, part));
    for (const r of rows) records.set(r.dedupeKey, toRecord(r));
  }

  // Flap history (already-correlated changes inside the flap window).
  const since = new Date(now.getTime() - config.flapWindowMin * 60_000);
  const hist = await db
    .select()
    .from(entityTransitions)
    .where(
      and(isNotNull(entityTransitions.correlatedAt), gte(entityTransitions.observedAt, since)),
    );
  const recentChanges = new Map<string, StateChange[]>();
  for (const row of hist) {
    const t = toTransition(row);
    const key = flapKeyOfTransition(t);
    if (!key) continue;
    const list = recentChanges.get(key) ?? [];
    list.push(...stateChangeOf(t));
    recentChanges.set(key, list);
  }

  return {
    now,
    config,
    transitions: opts.transitions,
    nodes,
    sites: siteMap,
    graph,
    seasons,
    maintenance,
    records,
    incidents: loadedIncidents,
    recentChanges,
  };
}

// ---------------------------------------------------------------------------------------------
// Persisting
// ---------------------------------------------------------------------------------------------

export interface PersistResult {
  /** "new:N" → DB id */
  created: Map<string, number>;
  touchedIncidentIds: number[];
  materialIncidentIds: number[];
}

export async function persistCorrelation(
  tx: Tx,
  out: CorrelationOutput,
  now: Date,
): Promise<PersistResult> {
  const created = new Map<string, number>();
  const idOf = (ref: string | null): number | null => {
    if (!ref) return null;
    if (ref.startsWith('id:')) return Number(ref.slice(3));
    return created.get(ref) ?? null;
  };

  for (const inc of out.incidents) {
    if (inc.ref.startsWith('new:')) {
      const [row] = await tx
        .insert(incidents)
        .values(incidentValues(inc))
        .returning({ id: incidents.id });
      created.set(inc.ref, row!.id);
    } else {
      await tx
        .update(incidents)
        .set(incidentValues(inc))
        .where(eq(incidents.id, idOf(inc.ref)!));
    }
  }

  for (const part of chunk(out.records, 500)) {
    await tx
      .insert(alertRecords)
      .values(
        part.map((r) => ({
          dedupeKey: r.key,
          source: r.source,
          alertId: r.alertId,
          alertName: r.alertName,
          entityUri: r.entityUri,
          entityType: r.entityType,
          entityCaption: r.entityCaption,
          nodeId: r.nodeId,
          interfaceId: r.interfaceId,
          siteId: r.siteId,
          severity: r.severity,
          state: r.state,
          firstSeenAt: r.firstSeenAt,
          lastSeenAt: r.lastSeenAt,
          lastRaisedAt: r.lastRaisedAt,
          clearedAt: r.clearedAt,
          triggerCount: r.triggerCount,
          currentAlertObjectId: r.currentAlertObjectId,
          currentAlertActiveId: r.currentAlertActiveId,
          lastMessage: r.lastMessage?.slice(0, 2000) ?? null,
          acknowledgedInOrion: r.acknowledgedInOrion,
          incidentId: idOf(r.incidentRef),
          suppressed: r.suppressed,
          seeded: r.seeded,
        })),
      )
      .onConflictDoUpdate({
        target: alertRecords.dedupeKey,
        set: {
          source: sql`excluded.source`,
          alertId: sql`excluded.alert_id`,
          alertName: sql`excluded.alert_name`,
          entityUri: sql`excluded.entity_uri`,
          entityType: sql`excluded.entity_type`,
          entityCaption: sql`excluded.entity_caption`,
          nodeId: sql`excluded.node_id`,
          interfaceId: sql`excluded.interface_id`,
          siteId: sql`excluded.site_id`,
          severity: sql`excluded.severity`,
          state: sql`excluded.state`,
          lastSeenAt: sql`excluded.last_seen_at`,
          lastRaisedAt: sql`excluded.last_raised_at`,
          clearedAt: sql`excluded.cleared_at`,
          triggerCount: sql`excluded.trigger_count`,
          currentAlertObjectId: sql`excluded.current_alert_object_id`,
          currentAlertActiveId: sql`excluded.current_alert_active_id`,
          lastMessage: sql`excluded.last_message`,
          acknowledgedInOrion: sql`excluded.acknowledged_in_orion`,
          incidentId: sql`excluded.incident_id`,
          suppressed: sql`excluded.suppressed`,
          seeded: sql`excluded.seeded`,
        },
      });
  }

  // Membership of every touched incident is rewritten from the engine's view (roles change too).
  for (const inc of out.incidents) {
    const incidentId = idOf(inc.ref)!;
    const keys = [...inc.members.keys()];
    const ids = new Map<string, number>();
    for (const part of chunk(keys, 1000)) {
      const rows = await tx
        .select({ id: alertRecords.id, key: alertRecords.dedupeKey })
        .from(alertRecords)
        .where(inArray(alertRecords.dedupeKey, part));
      for (const r of rows) ids.set(r.key, r.id);
    }
    const keep = [...ids.values()];
    await tx
      .delete(incidentMembers)
      .where(
        keep.length
          ? and(
              eq(incidentMembers.incidentId, incidentId),
              notInArray(incidentMembers.alertRecordId, keep),
            )
          : eq(incidentMembers.incidentId, incidentId),
      );
    for (const part of chunk([...inc.members], 500)) {
      const values = part
        .filter(([k]) => ids.has(k))
        .map(([k, role]) => ({ incidentId, alertRecordId: ids.get(k)!, role, addedAt: now }));
      if (values.length) {
        await tx
          .insert(incidentMembers)
          .values(values)
          .onConflictDoUpdate({
            target: [incidentMembers.incidentId, incidentMembers.alertRecordId],
            set: { role: sql`excluded.role` },
          });
      }
    }
  }

  const events = out.events
    .map((e) => ({
      incidentId: idOf(e.incidentRef),
      at: e.at,
      type: e.type,
      actor: e.actor,
      message: e.message,
      details: e.details ?? null,
    }))
    .filter((e): e is typeof e & { incidentId: number } => e.incidentId !== null);
  for (const part of chunk(events, 500)) await tx.insert(incidentEvents).values(part);

  for (const part of chunk(out.processedTransitionIds, 5000)) {
    await tx
      .update(entityTransitions)
      .set({ correlatedAt: now })
      .where(inArray(entityTransitions.id, part));
  }

  return {
    created,
    touchedIncidentIds: out.incidents.map((i) => idOf(i.ref)!),
    materialIncidentIds: out.materialChanges
      .map((r) => idOf(r))
      .filter((x): x is number => x !== null),
  };
}

// ---------------------------------------------------------------------------------------------
// Reconcile: make records agree with the current Orion mirror (startup, missed transitions)
// ---------------------------------------------------------------------------------------------

/**
 * Synthesise transitions for differences between active alert records and the mirror. Run only
 * while SWIS is up (the mirror is current). Synthetic transitions carry `reconcile: true`.
 */
export async function buildReconcileTransitions(db: DbOrTx, now: Date): Promise<TransitionIn[]> {
  const [mirror, activeRecs, nodeRows] = await inSequence([
    db.select().from(orionActiveAlerts),
    db.select().from(alertRecords).where(eq(alertRecords.state, 'active')),
    db
      .select({
        nodeId: orionNodes.nodeId,
        siteId: orionNodes.siteId,
        caption: orionNodes.caption,
        statusNorm: orionNodes.statusNorm,
      })
      .from(orionNodes)
      .where(and(isNull(orionNodes.removedAt), eq(orionNodes.unmanaged, false))),
  ]);
  const out: TransitionIn[] = [];
  const base = (
    p: Partial<TransitionIn> & Pick<TransitionIn, 'kind' | 'change' | 'toState'>,
  ): TransitionIn => ({
    id: null,
    entityKey: 'reconcile',
    nodeId: null,
    interfaceId: null,
    siteId: null,
    alertObjectId: null,
    alertActiveId: null,
    fromState: null,
    observedAt: now,
    sourceAt: null,
    details: { reconcile: true },
    ...p,
  });
  const activeKeys = new Set(activeRecs.map((r) => r.dedupeKey));
  const mirrorKeys = new Set<string>();
  for (const a of mirror) {
    const key = `${a.alertId}:${a.entityUri}`;
    mirrorKeys.add(key);
    if (activeKeys.has(key)) continue;
    out.push(
      base({
        kind: 'alert',
        change: 'raised',
        toState: 'active',
        nodeId: a.nodeId,
        interfaceId: a.interfaceId,
        siteId: a.siteId,
        alertObjectId: a.alertObjectId,
        alertActiveId: a.alertActiveId,
        sourceAt: a.triggeredAt,
        details: {
          reconcile: true,
          alertId: a.alertId,
          alertName: a.alertName,
          severity: a.severity,
          entityUri: a.entityUri,
          entityType: a.entityType,
          entityCaption: a.entityCaption,
          message: a.message,
        },
      }),
    );
  }
  for (const r of activeRecs) {
    if (r.source === 'orion' && !mirrorKeys.has(r.dedupeKey)) {
      out.push(
        base({
          kind: 'alert',
          change: 'cleared',
          toState: 'cleared',
          nodeId: r.nodeId,
          interfaceId: r.interfaceId,
          siteId: r.siteId,
          alertObjectId: r.currentAlertObjectId,
          details: { reconcile: true, alertId: r.alertId, entityUri: r.entityUri },
        }),
      );
    }
  }
  const statusActive = new Map(
    activeRecs.filter((r) => r.source === 'status').map((r) => [r.nodeId, r]),
  );
  for (const n of nodeRows) {
    const bad = n.statusNorm === 'down' || n.statusNorm === 'unreachable';
    const rec = statusActive.get(n.nodeId);
    if (bad && !rec) {
      out.push(
        base({
          kind: 'node',
          change: 'status',
          toState: n.statusNorm,
          nodeId: n.nodeId,
          siteId: n.siteId,
          details: { reconcile: true, caption: n.caption },
        }),
      );
    } else if (!bad && rec) {
      out.push(
        base({
          kind: 'node',
          change: 'status',
          toState: n.statusNorm,
          nodeId: n.nodeId,
          siteId: n.siteId,
          details: { reconcile: true, caption: n.caption },
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Read models for the web app
// ---------------------------------------------------------------------------------------------

export interface NoiseStats {
  rawAlerts: number;
  incidents: number;
  /** raw alert raises per incident opened; null when no incidents. */
  ratio: number | null;
}

/** The headline metric: raw Orion alert raises ÷ incidents opened (seeded/pre-existing excluded). */
export async function noiseStats(db: DbOrTx, since: Date): Promise<NoiseStats> {
  const [raw] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(entityTransitions)
    .where(
      and(
        eq(entityTransitions.kind, 'alert'),
        inArray(entityTransitions.change, ['raised', 'retriggered']),
        gte(entityTransitions.observedAt, since),
        sql`coalesce((${entityTransitions.details}->>'initialSync')::boolean, false) = false`,
      ),
    );
  const [inc] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(incidents)
    .where(and(gte(incidents.openedAt, since), eq(incidents.seeded, false)));
  const rawAlerts = raw?.n ?? 0;
  const count = inc?.n ?? 0;
  return {
    rawAlerts,
    incidents: count,
    ratio: count ? Math.round((rawAlerts / count) * 10) / 10 : null,
  };
}

export type IncidentListRow = IncidentRow & { siteName: string | null };

export async function listIncidents(
  db: DbOrTx,
  opts: { openOnly?: boolean; limit?: number } = {},
): Promise<IncidentListRow[]> {
  const rows = await db
    .select({ incident: incidents, siteName: sites.name })
    .from(incidents)
    .leftJoin(sites, eq(sites.id, incidents.primarySiteId))
    .where(opts.openOnly ? inArray(incidents.status, ['open', 'acknowledged']) : undefined)
    .orderBy(
      sql`CASE WHEN ${incidents.status} IN ('open','acknowledged') THEN 0 ELSE 1 END`,
      asc(incidents.priority),
      desc(incidents.openedAt),
    )
    .limit(opts.limit ?? 50);
  return rows.map((r) => ({ ...r.incident, siteName: r.siteName }));
}

export async function openIncidentCounts(
  db: DbOrTx,
): Promise<Record<'P1' | 'P2' | 'P3' | 'P4', number>> {
  const rows = await db
    .select({ priority: incidents.priority, n: sql<number>`count(*)::int` })
    .from(incidents)
    .where(inArray(incidents.status, ['open', 'acknowledged']))
    .groupBy(incidents.priority);
  const out = { P1: 0, P2: 0, P3: 0, P4: 0 };
  for (const r of rows) out[r.priority] = r.n;
  return out;
}

export async function getIncidentWithMembers(db: DbOrTx, id: number) {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, id));
  if (!inc) return null;
  const members = await db
    .select({ role: incidentMembers.role, record: alertRecords })
    .from(incidentMembers)
    .innerJoin(alertRecords, eq(alertRecords.id, incidentMembers.alertRecordId))
    .where(eq(incidentMembers.incidentId, id));
  const events = await db
    .select()
    .from(incidentEvents)
    .where(eq(incidentEvents.incidentId, id))
    .orderBy(asc(incidentEvents.at), asc(incidentEvents.id));
  return { incident: inc, members, events };
}
