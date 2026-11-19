import { describe, expect, it } from 'vitest';
import type { DeviceRole } from '../mapping';
import type { StatusNorm } from '../orion';
import { buildTopologyGraph } from './graph';
import { flapKeyOfTransition, runCorrelation, stateChangeOf } from './engine';
import type {
  AlertRecord,
  CorrelationConfig,
  IncidentState,
  MaintenanceWindow,
  NodeInfo,
  SeasonPeriod,
  SiteInfo,
  StateChange,
  TransitionIn,
} from './types';

const TZ = 'America/New_York';
const OFFICE = { days: [1, 2, 3, 4, 5], start: '07:00', end: '17:00' };
const HARVEST: SeasonPeriod = {
  id: 1,
  name: 'Harvest',
  kind: 'harvest',
  startMd: '09-01',
  endMd: '12-15',
  year: null,
  multiplier: 1.5,
  divisions: null,
  harvestCriticalOnly: false,
  enabled: true,
};
const cfg: CorrelationConfig = {
  windowSec: 180,
  holddownSec: 300,
  reopenWindowSec: 900,
  flapCount: 4,
  flapWindowMin: 20,
  maxAgeSec: 3600,
  upsAlertRegex: 'battery|utility power|on bypass|\\bups\\b',
  timezone: TZ,
  scoring: {
    p1Min: 70,
    p2Min: 50,
    p3Min: 30,
    tierCritical: 1.4,
    tierHigh: 1.2,
    harvestGrainMult: 1.2,
    afterHoursMult: 0.8,
    recoveryHarvestMin: 240,
    recoveryDefaultMin: 480,
  },
};
const sites = new Map<number, SiteInfo>([
  [
    1,
    {
      id: 1,
      name: 'Celina HQ',
      divisionCodes: ['corporate'],
      divisionNames: ['Corporate'],
      tier: 'critical',
      harvestCritical: false,
      businessHours: OFFICE,
      harvestHours: null,
    },
  ],
  [
    2,
    {
      id: 2,
      name: 'Rockford Elevator',
      divisionCodes: ['grain'],
      divisionNames: ['Grain'],
      tier: 'high',
      harvestCritical: true,
      businessHours: OFFICE,
      harvestHours: { days: [1, 2, 3, 4, 5, 6], start: '06:00', end: '22:00' },
    },
  ],
  [
    3,
    {
      id: 3,
      name: 'Coldwater Elevator',
      divisionCodes: ['grain'],
      divisionNames: ['Grain'],
      tier: 'high',
      harvestCritical: true,
      businessHours: OFFICE,
      harvestHours: null,
    },
  ],
]);
const NODE_DEFS: Array<[number, string, number, DeviceRole]> = [
  [11, 'CEL-FW01', 1, 'firewall'],
  [12, 'CEL-CORE01', 1, 'core_switch'],
  [13, 'CEL-DC01', 1, 'server'],
  [21, 'ROCK-FW01', 2, 'firewall'],
  [22, 'ROCK-SW01', 2, 'switch'],
  [23, 'ROCK-AP01', 2, 'access_point'],
  [24, 'ROCK-AP02', 2, 'access_point'],
  [25, 'ROCK-SCALE01', 2, 'scale_system'],
  [26, 'ROCK-SCALE02', 2, 'scale_system'],
  [27, 'ROCK-UPS01', 2, 'ups'],
  [31, 'COLD-FW01', 3, 'firewall'],
  [32, 'COLD-UPS01', 3, 'ups'],
];

class World {
  nodes = new Map<number, NodeInfo>(
    NODE_DEFS.map(([id, caption, siteId, role]) => [
      id,
      { nodeId: id, caption, siteId, role, statusNorm: 'up' as StatusNorm, unmanaged: false },
    ]),
  );
  graph = buildTopologyGraph({
    dependencies: [
      { parentNodeId: 21, childNodeId: null, parentContainerId: null, childContainerId: 200 },
    ],
    groupMembers: new Map([[200, [22, 23, 24, 25, 26, 27]]]),
    connections: [{ srcNodeId: 12, destNodeId: 11 }],
    roles: new Map(NODE_DEFS.map(([id, , , role]) => [id, role])),
  });
  records = new Map<string, AlertRecord>();
  incidents = new Map<string, IncidentState>();
  changes = new Map<string, StateChange[]>();
  maintenance: MaintenanceWindow[] = [];
  seasons: SeasonPeriod[] = [HARVEST];
  sites = new Map(sites);
  now: Date;
  private nextId = 1;
  private tid = 1;
  private objectIds = new Map<string, number>();
  pending: TransitionIn[] = [];

  constructor(start: string) {
    this.now = new Date(start);
  }

  advance(sec: number) {
    this.now = new Date(this.now.getTime() + sec * 1000);
  }

  private t(p: Partial<TransitionIn> & Pick<TransitionIn, 'kind' | 'change' | 'toState'>): void {
    this.pending.push({
      id: this.tid++,
      entityKey: 'x',
      nodeId: null,
      interfaceId: null,
      siteId: null,
      alertObjectId: null,
      alertActiveId: null,
      fromState: null,
      observedAt: this.now,
      sourceAt: null,
      details: {},
      ...p,
    });
  }

  alert(
    change: 'raised' | 'cleared' | 'retriggered',
    a: { alertId: number; name: string; severity: number; nodeId: number; ifaceId?: number },
  ) {
    const uri = `swis://o/Orion/Orion.Nodes/NodeID=${a.nodeId}${a.ifaceId ? `/Interfaces/InterfaceID=${a.ifaceId}` : ''}`;
    const objKey = `${a.alertId}:${uri}`;
    if (!this.objectIds.has(objKey)) this.objectIds.set(objKey, this.objectIds.size + 500);
    const node = this.nodes.get(a.nodeId)!;
    this.t({
      kind: 'alert',
      change,
      toState: change === 'cleared' ? 'cleared' : 'active',
      nodeId: a.nodeId,
      interfaceId: a.ifaceId ?? null,
      siteId: node.siteId,
      alertObjectId: this.objectIds.get(objKey)!,
      alertActiveId: this.tid + 10_000,
      details: {
        alertId: a.alertId,
        alertName: a.name,
        severity: a.severity,
        entityUri: uri,
        entityType: a.ifaceId ? 'Orion.NPM.Interfaces' : 'Orion.Nodes',
        entityCaption: a.ifaceId ? `${node.caption} · port${a.ifaceId}` : node.caption,
      },
    });
  }

  status(nodeId: number, to: StatusNorm) {
    const n = this.nodes.get(nodeId)!;
    const from = n.statusNorm;
    n.statusNorm = to;
    this.t({
      kind: 'node',
      change: 'status',
      fromState: from,
      toState: to,
      nodeId,
      siteId: n.siteId,
      details: { caption: n.caption },
    });
  }

  source(to: 'down' | 'up') {
    this.t({
      kind: 'source',
      change: to,
      toState: to,
      details: { reason: 'circuit breaker open' },
    });
  }

  /** Run the engine on pending transitions and persist results like the DB layer does. */
  correlate() {
    const history = new Map([...this.changes].map(([k, v]) => [k, [...v]]));
    for (const t of this.pending) {
      const fk = flapKeyOfTransition(t);
      if (fk) this.changes.set(fk, [...(this.changes.get(fk) ?? []), ...stateChangeOf(t)]);
    }
    const out = runCorrelation({
      now: this.now,
      config: cfg,
      transitions: this.pending,
      nodes: this.nodes,
      sites: this.sites,
      graph: this.graph,
      seasons: this.seasons,
      maintenance: this.maintenance,
      records: this.records,
      incidents: [...this.incidents.values()].filter((i) => i.status !== 'closed'),
      recentChanges: history, // like the DB layer: history before this batch
    });
    this.pending = [];
    const refMap = new Map<string, string>();
    for (const inc of out.incidents) {
      if (inc.ref.startsWith('new:')) {
        const id = this.nextId++;
        refMap.set(inc.ref, `id:${id}`);
        inc.ref = `id:${id}`;
        inc.id = id;
      }
      this.incidents.set(inc.ref, inc);
    }
    for (const r of out.records) {
      if (r.incidentRef && refMap.has(r.incidentRef)) r.incidentRef = refMap.get(r.incidentRef)!;
      this.records.set(r.key, r);
    }
    return {
      ...out,
      events: out.events.map((e) => ({
        ...e,
        incidentRef: refMap.get(e.incidentRef) ?? e.incidentRef,
      })),
    };
  }

  /** Re-run with history folded in (engine also counts changes passed via recentChanges). */
  open() {
    return [...this.incidents.values()].filter(
      (i) => i.status === 'open' || i.status === 'acknowledged',
    );
  }
}

const NODE_DOWN = { alertId: 1, name: 'Node is down', severity: 2 };

function wanDown(w: World) {
  w.alert('raised', { ...NODE_DOWN, nodeId: 21 });
  w.status(21, 'down');
  w.correlate();
  w.advance(30);
  for (const n of [22, 23, 24, 25, 26, 27]) w.status(n, 'unreachable');
  // 30 child alerts: node down + interface down + high response time on children
  let count = 0;
  for (const n of [22, 23, 24, 25, 26, 27]) {
    w.alert('raised', { ...NODE_DOWN, nodeId: n });
    w.alert('raised', {
      alertId: 3,
      name: 'Interface is down',
      severity: 1,
      nodeId: n,
      ifaceId: n * 10,
    });
    w.alert('raised', {
      alertId: 3,
      name: 'Interface is down',
      severity: 1,
      nodeId: n,
      ifaceId: n * 10 + 1,
    });
    w.alert('raised', { alertId: 6, name: 'High response time', severity: 1, nodeId: n });
    w.alert('raised', {
      alertId: 7,
      name: 'Interface errors',
      severity: 4,
      nodeId: n,
      ifaceId: n * 10,
    });
    count += 5;
  }
  expect(count).toBe(30);
  return w.correlate();
}

describe('correlation engine', () => {
  it('turns a WAN-edge outage with 30 child alerts into one P1 site outage (harvest, business hours)', () => {
    const w = new World('2026-10-14T14:00:00Z');
    const out = wanDown(w);
    const open = w.open();
    expect(open).toHaveLength(1);
    const inc = open[0]!;
    expect(inc).toMatchObject({
      kind: 'site_outage',
      priority: 'P1',
      rootNodeId: 21,
      primarySiteId: 2,
      alertCount: 31,
      recoveryTargetMin: 240,
    });
    expect(inc.title).toBe('Site down — Rockford Elevator');
    expect(inc.templateSummary).toMatch(/WAN edge firewall ROCK-FW01/);
    expect(inc.templateSummary).toMatch(/Scales at Rockford Elevator may be offline/);
    const roles = [...inc.members.values()];
    expect(roles.filter((r) => r === 'root')).toHaveLength(2); // the FW alert + its status record
    expect(roles.filter((r) => r === 'symptom').length).toBeGreaterThanOrEqual(30);
    expect(out.events.filter((e) => e.type === 'opened')).toHaveLength(0); // opened in the first run
  });

  it('gives an incident every division of its site', () => {
    const w = new World('2026-10-14T14:00:00Z');
    w.sites.set(2, {
      ...sites.get(2)!,
      divisionCodes: ['grain', 'agronomy'],
      divisionNames: ['Grain', 'Agronomy'],
    });
    wanDown(w);
    const inc = w.open()[0]!;
    expect(inc.divisionCodes).toEqual(['grain', 'agronomy']);
    expect(inc.templateSummary).toMatch(/Rockford Elevator \(Grain, Agronomy\)/);
  });

  it('scores the same outage in March after hours as P2', () => {
    const w = new World('2026-03-11T02:00:00Z');
    wanDown(w);
    expect(w.open()).toHaveLength(1);
    expect(w.open()[0]).toMatchObject({
      kind: 'site_outage',
      priority: 'P2',
      recoveryTargetMin: 480,
    });
  });

  it('dedupes re-triggers into one record with a count', () => {
    const w = new World('2026-10-14T14:00:00Z');
    w.alert('raised', { alertId: 2, name: 'High CPU load', severity: 1, nodeId: 13 });
    w.correlate();
    w.advance(60);
    w.alert('retriggered', { alertId: 2, name: 'High CPU load', severity: 1, nodeId: 13 });
    w.correlate();
    const recs = [...w.records.values()];
    expect(recs).toHaveLength(1);
    expect(recs[0]!.triggerCount).toBe(2);
    expect(w.open()).toHaveLength(1);
  });

  it('groups alerts at one site within the window, and starts a new incident after it', () => {
    const w = new World('2026-10-14T14:00:00Z');
    w.alert('raised', { alertId: 2, name: 'High CPU load', severity: 1, nodeId: 13 });
    w.correlate();
    w.advance(60);
    w.alert('raised', {
      alertId: 4,
      name: 'High interface utilization',
      severity: 1,
      nodeId: 12,
      ifaceId: 120,
    });
    w.correlate();
    expect(w.open()).toHaveLength(1);
    w.advance(600);
    w.alert('raised', {
      alertId: 4,
      name: 'High interface utilization',
      severity: 1,
      nodeId: 11,
      ifaceId: 110,
    });
    w.correlate();
    expect(w.open()).toHaveLength(2);
    // A different site never joins.
    w.alert('raised', { ...NODE_DOWN, nodeId: 32 });
    w.correlate();
    expect(w.open()).toHaveLength(3);
  });

  it('collapses a flapping access point into one flapping incident', () => {
    const w = new World('2026-10-14T14:00:00Z');
    for (let i = 0; i < 6; i++) {
      w.alert('raised', { ...NODE_DOWN, nodeId: 23 });
      w.status(23, 'down');
      w.correlate();
      w.advance(30);
      w.alert('cleared', { ...NODE_DOWN, nodeId: 23 });
      w.status(23, 'up');
      w.correlate();
      w.advance(30);
    }
    const all = [...w.incidents.values()].filter(
      (i) => i.status !== 'closed' || i.resolvedBy !== 'merged',
    );
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      kind: 'flapping',
      title: 'ROCK-AP01 flapping — Rockford Elevator',
    });
    expect(all[0]!.priority).toBe('P3');
  });

  it('resolves after the hold-down, reopens within the reopen window, then closes', () => {
    const w = new World('2026-10-14T14:00:00Z');
    w.alert('raised', { ...NODE_DOWN, nodeId: 22 });
    w.status(22, 'down');
    w.correlate();
    w.advance(120);
    w.alert('cleared', { ...NODE_DOWN, nodeId: 22 });
    w.status(22, 'up');
    w.correlate();
    const inc = () => [...w.incidents.values()][0]!;
    expect(inc().resolvePendingSince).not.toBeNull();
    w.advance(299);
    w.correlate();
    expect(inc().status).toBe('open');
    w.advance(2);
    const res = w.correlate();
    expect(inc().status).toBe('resolved');
    expect(res.events.map((e) => e.type)).toContain('resolved');
    w.advance(300);
    w.alert('raised', { ...NODE_DOWN, nodeId: 22 });
    const re = w.correlate();
    expect(inc().status).toBe('open');
    expect(re.events.map((e) => e.type)).toContain('reopened');
    expect(w.incidents.size).toBe(1);
    w.alert('cleared', { ...NODE_DOWN, nodeId: 22 });
    w.correlate();
    w.advance(301);
    w.correlate();
    w.advance(901);
    w.correlate();
    expect(inc().status).toBe('closed');
  });

  it('keeps a manual resolve while alerts stay active; a new raise reopens it', () => {
    const w = new World('2026-10-14T14:00:00Z');
    w.alert('raised', { ...NODE_DOWN, nodeId: 22 });
    w.status(22, 'down');
    w.correlate();
    const inc = () => [...w.incidents.values()][0]!;
    // Someone resolves it in the dashboard while Orion still has the alert active.
    Object.assign(inc(), { status: 'resolved', resolvedAt: w.now, resolvedBy: 'user:Pat' });
    w.advance(60);
    w.correlate();
    expect(inc().status).toBe('resolved');
    w.advance(1000);
    w.correlate();
    expect(inc().status).toBe('closed');
    expect(w.incidents.size).toBe(1); // no duplicate for the still-active alert
    // The alert clears and fires again: that is news.
    w.alert('cleared', { ...NODE_DOWN, nodeId: 22 });
    w.correlate();
    w.advance(30);
    w.alert('raised', { ...NODE_DOWN, nodeId: 22 });
    w.correlate();
    expect([...w.incidents.values()].filter((i) => i.status === 'open')).toHaveLength(1);
  });

  it('holds back incidents during a maintenance window that suppresses them, then raises them', () => {
    const w = new World('2026-10-14T14:00:00Z');
    w.maintenance = [
      {
        id: 1,
        scope: 'site',
        siteId: 2,
        nodeId: null,
        startsAt: new Date('2026-10-14T13:00:00Z'),
        endsAt: new Date('2026-10-14T15:00:00Z'),
        recurrence: null,
        suppress: 'incidents',
        reason: 'firmware',
      },
    ];
    w.alert('raised', { ...NODE_DOWN, nodeId: 23 });
    w.correlate();
    expect(w.incidents.size).toBe(0);
    expect([...w.records.values()][0]!.suppressed).toBe(true);
    w.advance(3600);
    w.correlate();
    expect(w.open()).toHaveLength(1);
    expect(w.open()[0]!.kind).toBe('device_down');
  });

  it('flags incidents in a notification-only maintenance window', () => {
    const w = new World('2026-10-14T14:00:00Z');
    w.maintenance = [
      {
        id: 1,
        scope: 'node',
        siteId: null,
        nodeId: 23,
        startsAt: new Date('2026-10-14T13:00:00Z'),
        endsAt: null,
        recurrence: null,
        suppress: 'notifications',
        reason: null,
      },
    ];
    w.alert('raised', { ...NODE_DOWN, nodeId: 23 });
    w.status(23, 'down');
    w.correlate();
    expect(w.open()[0]!.inMaintenance).toBe(true);
  });

  it('raises a fixed-P1 "monitoring source down" incident and resolves it when SWIS returns', () => {
    const w = new World('2026-03-11T02:00:00Z');
    w.source('down');
    w.correlate();
    expect(w.open()).toHaveLength(1);
    expect(w.open()[0]).toMatchObject({
      kind: 'monitoring_source_down',
      priority: 'P1',
      title: 'SolarWinds monitoring unavailable',
    });
    w.advance(240);
    w.source('up');
    w.correlate();
    w.advance(301);
    w.correlate();
    expect([...w.incidents.values()][0]!.status).toBe('resolved');
  });

  it('classifies a UPS on battery at a harvest-critical site in harvest as P2 power incident', () => {
    const w = new World('2026-10-14T14:00:00Z');
    w.alert('raised', { alertId: 5, name: 'UPS on battery', severity: 3, nodeId: 32 });
    w.correlate();
    expect(w.open()[0]).toMatchObject({
      kind: 'ups_power',
      priority: 'P2',
      title: 'UPS on battery — Coldwater Elevator',
    });
  });

  it('classifies HQ WAN saturation as a P3 interface incident', () => {
    const w = new World('2026-10-14T14:00:00Z');
    w.alert('raised', {
      alertId: 4,
      name: 'High interface utilization',
      severity: 1,
      nodeId: 11,
      ifaceId: 110,
    });
    w.correlate();
    expect(w.open()[0]).toMatchObject({ kind: 'interface', priority: 'P3' });
  });

  it('upgrades a site incident when the firewall turns out to be the cause', () => {
    const w = new World('2026-10-14T14:00:00Z');
    w.alert('raised', { alertId: 6, name: 'High response time', severity: 1, nodeId: 25 });
    w.correlate();
    expect(w.open()[0]!.kind).toBe('generic');
    w.advance(30);
    w.alert('raised', { ...NODE_DOWN, nodeId: 21 });
    w.status(21, 'down');
    for (const n of [22, 23, 24, 25, 26, 27]) w.status(n, 'unreachable');
    const out = w.correlate();
    expect(w.open()).toHaveLength(1);
    expect(w.open()[0]).toMatchObject({ kind: 'site_outage', priority: 'P1' });
    expect(out.materialChanges).toHaveLength(1);
    expect(out.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['kind_changed', 'priority_changed']),
    );
  });

  it('ignores stale backlog older than maxAge', () => {
    const w = new World('2026-10-14T14:00:00Z');
    w.alert('raised', { ...NODE_DOWN, nodeId: 22 });
    w.advance(7200);
    const out = w.correlate();
    expect(out.processedTransitionIds).toHaveLength(1);
    expect(w.incidents.size).toBe(0);
  });

  it('marks incidents from initial-sync alerts as seeded', () => {
    const w = new World('2026-10-14T14:00:00Z');
    w.alert('raised', { ...NODE_DOWN, nodeId: 22 });
    w.pending[0]!.details.initialSync = true;
    w.correlate();
    expect(w.open()[0]!.seeded).toBe(true);
    w.advance(30);
    w.alert('raised', { alertId: 6, name: 'High response time', severity: 1, nodeId: 22 });
    w.correlate();
    expect(w.open()[0]!.seeded).toBe(false);
  });

  it('repairs incidents correlated before node data existed (first start)', () => {
    const w = new World('2026-10-14T14:00:00Z');
    const fw = w.nodes.get(11)!;
    w.nodes.delete(11); // mirror not populated yet
    w.alert('raised', {
      alertId: 4,
      name: 'High interface utilization',
      severity: 1,
      nodeId: 12,
      ifaceId: 120,
    });
    w.pending[0]!.siteId = null;
    w.nodes.delete(12);
    w.correlate();
    expect(w.open()[0]).toMatchObject({ primarySiteId: null, priority: 'P4' });
    w.nodes.set(11, fw);
    w.nodes.set(12, {
      nodeId: 12,
      caption: 'CEL-CORE01',
      siteId: 1,
      role: 'core_switch',
      statusNorm: 'up',
      unmanaged: false,
    });
    w.advance(30);
    w.correlate();
    expect(w.open()[0]).toMatchObject({ primarySiteId: 1, kind: 'interface', priority: 'P3' });
  });
});
