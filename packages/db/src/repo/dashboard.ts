/**
 * Read-only queries behind the dashboard and the wall. The web app only reads the database (rule 1);
 * colours, health and the merged timeline are computed by pure functions in @mercer/core.
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { IncidentKind, IncidentStatus, Priority } from '@mercer/core';
import {
  alertRecords,
  auditLog,
  divisions,
  entityTransitions,
  incidentEvents,
  incidentMembers,
  incidents,
  interfaceMetrics5m,
  nodeMetrics5m,
  orionActiveAlerts,
  orionAlertHistory,
  orionEvents,
  orionInterfaces,
  orionNodes,
  sites,
} from '../schema';
import type { DbOrTx } from '../client';
import { inSequence } from './helpers';

export type IncidentRow = typeof incidents.$inferSelect;
export type NodeRow = typeof orionNodes.$inferSelect;
export type InterfaceRow = typeof orionInterfaces.$inferSelect;
export type SiteRowFull = typeof sites.$inferSelect;

const OPEN_STATUSES = ['open', 'acknowledged'] as const;

// ---------------------------------------------------------------------------------------------
// Overview and wall
// ---------------------------------------------------------------------------------------------

export interface OverviewSite extends SiteRowFull {
  divisionName: string | null;
  divisionSort: number;
  isAffiliate: boolean;
}

export interface OverviewNode {
  nodeId: number;
  siteId: number | null;
  statusNorm: string;
  role: string;
  unmanaged: boolean;
}

export type OverviewIncident = IncidentRow & { siteName: string | null };

export interface OverviewData {
  sites: OverviewSite[];
  nodes: OverviewNode[];
  openIncidents: OverviewIncident[];
}

export async function loadOverview(db: DbOrTx): Promise<OverviewData> {
  const [siteRows, nodeRows, incRows] = await inSequence([
    db
      .select({
        site: sites,
        divisionName: divisions.name,
        divisionSort: divisions.sortOrder,
        isAffiliate: divisions.isAffiliate,
      })
      .from(sites)
      .leftJoin(divisions, eq(divisions.code, sites.divisionCode))
      .orderBy(asc(divisions.sortOrder), asc(sites.name)),
    db
      .select({
        nodeId: orionNodes.nodeId,
        siteId: orionNodes.siteId,
        statusNorm: orionNodes.statusNorm,
        role: orionNodes.deviceRole,
        unmanaged: orionNodes.unmanaged,
      })
      .from(orionNodes)
      .where(isNull(orionNodes.removedAt)),
    db
      .select({ incident: incidents, siteName: sites.name })
      .from(incidents)
      .leftJoin(sites, eq(sites.id, incidents.primarySiteId))
      .where(inArray(incidents.status, [...OPEN_STATUSES]))
      .orderBy(asc(incidents.priority), desc(incidents.openedAt)),
  ]);
  return {
    sites: siteRows.map((r) => ({
      ...r.site,
      divisionName: r.divisionName,
      divisionSort: r.divisionSort ?? 999,
      isAffiliate: r.isAffiliate ?? false,
    })),
    nodes: nodeRows,
    openIncidents: incRows.map((r) => ({ ...r.incident, siteName: r.siteName })),
  };
}

// ---------------------------------------------------------------------------------------------
// Incident list
// ---------------------------------------------------------------------------------------------

export const INCIDENT_STATUS_FILTERS = ['active', 'resolved', 'closed', 'all'] as const;
export type IncidentStatusFilter = (typeof INCIDENT_STATUS_FILTERS)[number];

export interface IncidentFilter {
  status?: IncidentStatusFilter;
  priorities?: Priority[];
  division?: string;
  siteId?: number;
  kind?: IncidentKind;
  q?: string;
  since?: Date;
  /** Paging for non-active lists: incidents with a smaller id. */
  beforeId?: number;
  limit?: number;
}

export type IncidentListItem = IncidentRow & {
  siteName: string | null;
  divisionName: string | null;
};

export async function searchIncidents(
  db: DbOrTx,
  f: IncidentFilter,
): Promise<{ rows: IncidentListItem[]; nextBeforeId: number | null }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const where: SQL[] = [];
  const status = f.status ?? 'active';
  if (status === 'active') where.push(inArray(incidents.status, [...OPEN_STATUSES]));
  else if (status !== 'all') where.push(eq(incidents.status, status as IncidentStatus));
  if (f.priorities?.length) where.push(inArray(incidents.priority, f.priorities));
  if (f.division) where.push(eq(incidents.divisionCode, f.division));
  if (f.siteId)
    where.push(
      or(
        eq(incidents.primarySiteId, f.siteId),
        sql`${f.siteId} = ANY(${incidents.affectedSiteIds})`,
      )!,
    );
  if (f.kind) where.push(eq(incidents.kind, f.kind));
  if (f.q?.trim()) {
    const q = f.q.trim();
    const id = /^(?:inc-)?(\d+)$/i.exec(q);
    where.push(
      id
        ? eq(incidents.id, Number(id[1]))
        : or(ilike(incidents.title, `%${q}%`), ilike(incidents.aiTitle, `%${q}%`))!,
    );
  }
  if (f.since) where.push(gte(incidents.openedAt, f.since));
  if (f.beforeId && status !== 'active') where.push(lt(incidents.id, f.beforeId));

  const rows = await db
    .select({ incident: incidents, siteName: sites.name, divisionName: divisions.name })
    .from(incidents)
    .leftJoin(sites, eq(sites.id, incidents.primarySiteId))
    .leftJoin(divisions, eq(divisions.code, incidents.divisionCode))
    .where(where.length ? and(...where) : undefined)
    .orderBy(
      ...(status === 'active'
        ? [asc(incidents.priority), desc(incidents.openedAt)]
        : [desc(incidents.id)]),
    )
    .limit(limit + 1);
  const page = rows.slice(0, limit).map((r) => ({
    ...r.incident,
    siteName: r.siteName,
    divisionName: r.divisionName,
  }));
  return {
    rows: page,
    nextBeforeId: rows.length > limit && status !== 'active' ? page.at(-1)!.id : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Incident detail
// ---------------------------------------------------------------------------------------------

export async function getIncidentDetail(db: DbOrTx, id: number, now = new Date()) {
  const [head] = await db
    .select({ incident: incidents, site: sites, divisionName: divisions.name })
    .from(incidents)
    .leftJoin(sites, eq(sites.id, incidents.primarySiteId))
    .leftJoin(divisions, eq(divisions.code, incidents.divisionCode))
    .where(eq(incidents.id, id));
  if (!head) return null;
  const inc = head.incident;

  const members = await db
    .select({ role: incidentMembers.role, addedAt: incidentMembers.addedAt, record: alertRecords })
    .from(incidentMembers)
    .innerJoin(alertRecords, eq(alertRecords.id, incidentMembers.alertRecordId))
    .where(eq(incidentMembers.incidentId, id))
    .orderBy(
      sql`CASE ${incidentMembers.role} WHEN 'root' THEN 0 WHEN 'symptom' THEN 1 ELSE 2 END`,
      desc(alertRecords.lastRaisedAt),
    );
  const events = await db
    .select()
    .from(incidentEvents)
    .where(eq(incidentEvents.incidentId, id))
    .orderBy(asc(incidentEvents.at), asc(incidentEvents.id));

  const nodeIds = [
    ...new Set(
      [inc.rootNodeId, ...members.map((m) => m.record.nodeId)].filter(
        (x): x is number => x !== null,
      ),
    ),
  ];
  const ifIds = [
    ...new Set(members.map((m) => m.record.interfaceId).filter((x): x is number => x !== null)),
  ];
  const alertObjectIds = [
    ...new Set(
      members.map((m) => m.record.currentAlertObjectId).filter((x): x is number => x !== null),
    ),
  ];
  const from = new Date(inc.openedAt.getTime() - 10 * 60_000);
  const to = new Date((inc.closedAt ?? now).getTime() + 5 * 60_000);

  const scope: SQL[] = [];
  if (nodeIds.length)
    scope.push(
      and(eq(entityTransitions.kind, 'node'), inArray(entityTransitions.nodeId, nodeIds))!,
    );
  if (ifIds.length)
    scope.push(
      and(eq(entityTransitions.kind, 'interface'), inArray(entityTransitions.interfaceId, ifIds))!,
    );
  if (alertObjectIds.length)
    scope.push(
      and(
        eq(entityTransitions.kind, 'alert'),
        inArray(entityTransitions.alertObjectId, alertObjectIds),
      )!,
    );
  if (inc.kind === 'monitoring_source_down') scope.push(eq(entityTransitions.kind, 'source'));

  const [transitions, orionEvts, history, affectedNodes, affectedIfs] = await inSequence([
    scope.length
      ? db
          .select()
          .from(entityTransitions)
          .where(
            and(
              gte(entityTransitions.observedAt, from),
              lte(entityTransitions.observedAt, to),
              or(...scope),
            ),
          )
          .orderBy(asc(entityTransitions.observedAt))
          .limit(500)
      : Promise.resolve([] as Array<typeof entityTransitions.$inferSelect>),
    nodeIds.length
      ? db
          .select()
          .from(orionEvents)
          .where(
            and(
              inArray(orionEvents.nodeId, nodeIds),
              gte(orionEvents.eventTime, from),
              lte(orionEvents.eventTime, to),
            ),
          )
          .orderBy(asc(orionEvents.eventTime))
          .limit(200)
      : Promise.resolve([] as Array<typeof orionEvents.$inferSelect>),
    alertObjectIds.length
      ? db
          .select()
          .from(orionAlertHistory)
          .where(
            and(
              inArray(orionAlertHistory.alertObjectId, alertObjectIds),
              gte(orionAlertHistory.at, from),
              lte(orionAlertHistory.at, to),
            ),
          )
          .orderBy(asc(orionAlertHistory.at))
          .limit(200)
      : Promise.resolve([] as Array<typeof orionAlertHistory.$inferSelect>),
    nodeIds.length
      ? db
          .select({ node: orionNodes, siteName: sites.name })
          .from(orionNodes)
          .leftJoin(sites, eq(sites.id, orionNodes.siteId))
          .where(inArray(orionNodes.nodeId, nodeIds))
          .orderBy(asc(orionNodes.caption))
      : Promise.resolve([] as Array<{ node: NodeRow; siteName: string | null }>),
    ifIds.length
      ? db
          .select({ iface: orionInterfaces, nodeCaption: orionNodes.caption })
          .from(orionInterfaces)
          .leftJoin(orionNodes, eq(orionNodes.nodeId, orionInterfaces.nodeId))
          .where(inArray(orionInterfaces.interfaceId, ifIds))
      : Promise.resolve([] as Array<{ iface: InterfaceRow; nodeCaption: string | null }>),
  ]);

  const captionByNode = new Map(affectedNodes.map((n) => [n.node.nodeId, n.node.caption]));
  const captionByObject = new Map(
    members
      .filter((m) => m.record.currentAlertObjectId !== null)
      .map((m) => [m.record.currentAlertObjectId!, m.record.entityCaption ?? m.record.alertName]),
  );

  return {
    incident: inc,
    site: head.site,
    divisionName: head.divisionName,
    members,
    events,
    affectedNodes,
    affectedInterfaces: affectedIfs,
    timelineInput: {
      incidentEvents: events,
      transitions: transitions.map((t) => {
        const d = t.details as Record<string, unknown>;
        const caption =
          (typeof d.entityCaption === 'string' && d.entityCaption) ||
          (typeof d.caption === 'string' && d.caption) ||
          (t.nodeId !== null ? captionByNode.get(t.nodeId) : undefined) ||
          t.entityKey;
        return {
          observedAt: t.observedAt,
          sourceAt: t.sourceAt,
          kind: t.kind,
          change: t.change,
          fromState: t.fromState,
          toState: t.toState,
          label: caption,
          alertName: typeof d.alertName === 'string' ? d.alertName : null,
        };
      }),
      orionEvents: orionEvts,
      alertHistory: history.map((h) => ({
        at: h.at,
        eventType: h.eventType,
        message: h.message,
        accountId: h.accountId,
        label: (h.alertObjectId !== null && captionByObject.get(h.alertObjectId)) || 'Orion alert',
      })),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Site, node and interface pages
// ---------------------------------------------------------------------------------------------

export async function getSiteDetail(db: DbOrTx, code: string, now = new Date()) {
  const [head] = await db
    .select({ site: sites, divisionName: divisions.name })
    .from(sites)
    .leftJoin(divisions, eq(divisions.code, sites.divisionCode))
    .where(eq(sql`lower(${sites.code})`, code.toLowerCase()));
  if (!head) return null;
  const siteId = head.site.id;
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [nodes, ifaces, recent, activeAlerts] = await inSequence([
    db
      .select()
      .from(orionNodes)
      .where(and(eq(orionNodes.siteId, siteId), isNull(orionNodes.removedAt)))
      .orderBy(asc(orionNodes.caption)),
    db
      .select({ iface: orionInterfaces, nodeCaption: orionNodes.caption })
      .from(orionInterfaces)
      .innerJoin(orionNodes, eq(orionNodes.nodeId, orionInterfaces.nodeId))
      .where(
        and(
          eq(orionNodes.siteId, siteId),
          isNull(orionNodes.removedAt),
          isNull(orionInterfaces.removedAt),
        ),
      )
      .orderBy(asc(orionNodes.caption), asc(orionInterfaces.caption)),
    db
      .select()
      .from(incidents)
      .where(
        and(
          or(
            eq(incidents.primarySiteId, siteId),
            sql`${siteId} = ANY(${incidents.affectedSiteIds})`,
          ),
          or(inArray(incidents.status, [...OPEN_STATUSES]), gte(incidents.openedAt, since)),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${incidents.status} IN ('open','acknowledged') THEN 0 ELSE 1 END`,
        desc(incidents.openedAt),
      )
      .limit(50),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(orionActiveAlerts)
      .where(eq(orionActiveAlerts.siteId, siteId)),
  ]);
  return {
    site: head.site,
    divisionName: head.divisionName,
    nodes,
    interfaces: ifaces,
    incidents: recent,
    activeAlertCount: activeAlerts[0]?.n ?? 0,
  };
}

export async function getNodeDetail(db: DbOrTx, nodeId: number, now = new Date()) {
  const [head] = await db
    .select({ node: orionNodes, site: sites })
    .from(orionNodes)
    .leftJoin(sites, eq(sites.id, orionNodes.siteId))
    .where(eq(orionNodes.nodeId, nodeId));
  if (!head) return null;
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [ifaces, history, alerts, recent] = await inSequence([
    db
      .select()
      .from(orionInterfaces)
      .where(and(eq(orionInterfaces.nodeId, nodeId), isNull(orionInterfaces.removedAt)))
      .orderBy(asc(orionInterfaces.caption)),
    db
      .select()
      .from(entityTransitions)
      .where(
        and(
          eq(entityTransitions.kind, 'node'),
          eq(entityTransitions.nodeId, nodeId),
          gte(entityTransitions.observedAt, since),
        ),
      )
      .orderBy(desc(entityTransitions.observedAt))
      .limit(100),
    db
      .select()
      .from(orionActiveAlerts)
      .where(eq(orionActiveAlerts.nodeId, nodeId))
      .orderBy(desc(orionActiveAlerts.triggeredAt)),
    db
      .selectDistinct({
        id: incidents.id,
        title: incidents.title,
        aiTitle: incidents.aiTitle,
        priority: incidents.priority,
        status: incidents.status,
        openedAt: incidents.openedAt,
        resolvedAt: incidents.resolvedAt,
      })
      .from(incidents)
      .innerJoin(incidentMembers, eq(incidentMembers.incidentId, incidents.id))
      .innerJoin(alertRecords, eq(alertRecords.id, incidentMembers.alertRecordId))
      .where(and(eq(alertRecords.nodeId, nodeId), gte(incidents.openedAt, since)))
      .orderBy(desc(incidents.openedAt))
      .limit(30),
  ]);
  return {
    node: head.node,
    site: head.site,
    interfaces: ifaces,
    history,
    activeAlerts: alerts,
    incidents: recent,
  };
}

export async function getInterfaceDetail(db: DbOrTx, interfaceId: number, now = new Date()) {
  const [head] = await db
    .select({ iface: orionInterfaces, node: orionNodes, site: sites })
    .from(orionInterfaces)
    .innerJoin(orionNodes, eq(orionNodes.nodeId, orionInterfaces.nodeId))
    .leftJoin(sites, eq(sites.id, orionNodes.siteId))
    .where(eq(orionInterfaces.interfaceId, interfaceId));
  if (!head) return null;
  const history = await db
    .select()
    .from(entityTransitions)
    .where(
      and(
        eq(entityTransitions.kind, 'interface'),
        eq(entityTransitions.interfaceId, interfaceId),
        gte(entityTransitions.observedAt, new Date(now.getTime() - 30 * 86_400_000)),
      ),
    )
    .orderBy(desc(entityTransitions.observedAt))
    .limit(100);
  return { ...head, history };
}

// ---------------------------------------------------------------------------------------------
// Metric series (5-minute rollups, re-binned for longer ranges)
// ---------------------------------------------------------------------------------------------

export const METRIC_RANGES = {
  '24h': { ms: 86_400_000, bin: null },
  '7d': { ms: 7 * 86_400_000, bin: '30 minutes' },
  '30d': { ms: 30 * 86_400_000, bin: '2 hours' },
} as const;
export type MetricRange = keyof typeof METRIC_RANGES;

const binOf = (col: AnyPgColumn, bin: string | null) =>
  bin ? sql<Date>`date_bin(${bin}::interval, ${col}, timestamptz '2000-01-01')` : sql<Date>`${col}`;

/** Sample-weighted average of a running-average column. */
const wavg = (col: SQL | unknown, samples: unknown) =>
  sql<
    number | null
  >`(sum(${col} * ${samples}) / nullif(sum(case when ${col} is null then 0 else ${samples} end), 0))::real`;

export interface NodeMetricPoint {
  t: Date;
  rtAvg: number | null;
  rtMax: number | null;
  lossAvg: number | null;
  lossMax: number | null;
  cpuAvg: number | null;
  cpuMax: number | null;
  memAvg: number | null;
  memMax: number | null;
}

export async function nodeMetricSeries(
  db: DbOrTx,
  nodeId: number,
  range: MetricRange,
  now = new Date(),
): Promise<NodeMetricPoint[]> {
  const r = METRIC_RANGES[range];
  const m = nodeMetrics5m;
  const t = binOf(m.bucket, r.bin);
  const rows = await db
    .select({
      t,
      rtAvg: wavg(m.rtAvg, m.samples),
      rtMax: sql<number | null>`max(${m.rtMax})`,
      lossAvg: wavg(m.lossAvg, m.samples),
      lossMax: sql<number | null>`max(${m.lossMax})`,
      cpuAvg: wavg(m.cpuAvg, m.samples),
      cpuMax: sql<number | null>`max(${m.cpuMax})`,
      memAvg: wavg(m.memAvg, m.samples),
      memMax: sql<number | null>`max(${m.memMax})`,
    })
    .from(m)
    .where(and(eq(m.nodeId, nodeId), gte(m.bucket, new Date(now.getTime() - r.ms))))
    // By position: the bucket expression carries bind parameters, which GROUP BY cannot match.
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows.map((x) => ({ ...x, t: new Date(x.t) }));
}

export interface InterfaceMetricPoint {
  t: Date;
  inAvg: number | null;
  inMax: number | null;
  outAvg: number | null;
  outMax: number | null;
  errors: number | null;
  discards: number | null;
}

export async function interfaceMetricSeries(
  db: DbOrTx,
  interfaceId: number,
  range: MetricRange,
  now = new Date(),
): Promise<InterfaceMetricPoint[]> {
  const r = METRIC_RANGES[range];
  const m = interfaceMetrics5m;
  const t = binOf(m.bucket, r.bin);
  const rows = await db
    .select({
      t,
      inAvg: wavg(m.inUtilAvg, m.samples),
      inMax: sql<number | null>`max(${m.inUtilMax})`,
      outAvg: wavg(m.outUtilAvg, m.samples),
      outMax: sql<number | null>`max(${m.outUtilMax})`,
      errors: sql<
        number | null
      >`max(coalesce(${m.inErrors}, 0) + coalesce(${m.outErrors}, 0))::real`,
      discards: sql<
        number | null
      >`max(coalesce(${m.inDiscards}, 0) + coalesce(${m.outDiscards}, 0))::real`,
    })
    .from(m)
    .where(and(eq(m.interfaceId, interfaceId), gte(m.bucket, new Date(now.getTime() - r.ms))))
    // By position: the bucket expression carries bind parameters, which GROUP BY cannot match.
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows.map((x) => ({ ...x, t: new Date(x.t) }));
}

// ---------------------------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------------------------

export async function listAudit(
  db: DbOrTx,
  opts: { limit?: number; beforeId?: number; actionPrefix?: string } = {},
) {
  const where: SQL[] = [];
  if (opts.beforeId) where.push(lt(auditLog.id, opts.beforeId));
  if (opts.actionPrefix) where.push(ilike(auditLog.action, `${opts.actionPrefix}%`));
  const limit = Math.min(opts.limit ?? 100, 500);
  const rows = await db
    .select()
    .from(auditLog)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  return {
    rows: rows.slice(0, limit),
    nextBeforeId: rows.length > limit ? rows[limit - 1]!.id : null,
  };
}
