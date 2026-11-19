/**
 * Aggregates over history, shared by the Trends page, the digests and the chat tools:
 * busiest interfaces, flapping devices, recurring problems and the daily noise series.
 */
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
  entityTransitions,
  incidents,
  interfaceMetrics5m,
  orionInterfaces,
  orionNodes,
  sites,
} from '../schema';
import { localDateTime } from '@mercer/core';
import type { DbOrTx } from '../client';

export interface Period {
  start: Date;
  end: Date;
}

export interface InterfaceUtilRow {
  interfaceId: number;
  nodeId: number;
  iface: string;
  node: string;
  siteCode: string | null;
  site: string | null;
  /** Highest 5-minute peak of in or out, percent. */
  peak: number;
  /** Average of the busier direction, percent. */
  avg: number;
  inAvg: number;
  outAvg: number;
  p95: number;
  daysOver80: number;
}

/** Busiest interfaces ("top talkers") over a period, from the 5-minute rollups. */
export async function topInterfaces(
  db: DbOrTx,
  p: Period & { limit: number; nodeId?: number | null; siteId?: number | null },
): Promise<InterfaceUtilRow[]> {
  const peak = sql<number>`greatest(coalesce(${interfaceMetrics5m.inUtilMax}, 0), coalesce(${interfaceMetrics5m.outUtilMax}, 0))`;
  const busy = sql<number>`greatest(coalesce(${interfaceMetrics5m.inUtilAvg}, 0), coalesce(${interfaceMetrics5m.outUtilAvg}, 0))`;
  const where: SQL[] = [
    gte(interfaceMetrics5m.bucket, p.start),
    lt(interfaceMetrics5m.bucket, p.end),
  ];
  if (p.nodeId) where.push(eq(orionInterfaces.nodeId, p.nodeId));
  if (p.siteId) where.push(eq(orionNodes.siteId, p.siteId));
  return db
    .select({
      interfaceId: interfaceMetrics5m.interfaceId,
      nodeId: sql<number>`max(${orionInterfaces.nodeId})::int`,
      iface: sql<string>`coalesce(max(${orionInterfaces.name}), max(${orionInterfaces.caption}), 'interface')`,
      node: sql<string>`max(${orionNodes.caption})`,
      siteCode: sql<string | null>`max(${sites.code})`,
      site: sql<string | null>`max(${sites.name})`,
      peak: sql<number>`round(max(${peak})::numeric)::int`,
      avg: sql<number>`round(avg(${busy})::numeric)::int`,
      inAvg: sql<number>`round(coalesce(avg(${interfaceMetrics5m.inUtilAvg}), 0)::numeric)::int`,
      outAvg: sql<number>`round(coalesce(avg(${interfaceMetrics5m.outUtilAvg}), 0)::numeric)::int`,
      p95: sql<number>`round((percentile_cont(0.95) within group (order by ${busy}))::numeric)::int`,
      daysOver80: sql<number>`count(distinct date_trunc('day', ${interfaceMetrics5m.bucket})) filter (where ${busy} >= 80)::int`,
    })
    .from(interfaceMetrics5m)
    .innerJoin(orionInterfaces, eq(orionInterfaces.interfaceId, interfaceMetrics5m.interfaceId))
    .innerJoin(orionNodes, eq(orionNodes.nodeId, orionInterfaces.nodeId))
    .leftJoin(sites, eq(sites.id, orionNodes.siteId))
    .where(and(...where))
    .groupBy(interfaceMetrics5m.interfaceId)
    .orderBy(desc(sql`max(${peak})`), desc(sql`avg(${busy})`))
    .limit(p.limit);
}

export interface FlappingRow {
  nodeId: number;
  node: string;
  role: string;
  siteCode: string | null;
  site: string | null;
  changes: number;
}

/** Devices with at least `min` state changes in the period, most first. */
export async function flappingNodes(
  db: DbOrTx,
  p: Period & { min: number; limit: number },
): Promise<FlappingRow[]> {
  return db
    .select({
      nodeId: sql<number>`${entityTransitions.nodeId}::int`,
      node: sql<string>`max(${orionNodes.caption})`,
      role: sql<string>`max(${orionNodes.deviceRole})`,
      siteCode: sql<string | null>`max(${sites.code})`,
      site: sql<string | null>`max(${sites.name})`,
      changes: sql<number>`count(*)::int`,
    })
    .from(entityTransitions)
    .innerJoin(orionNodes, eq(orionNodes.nodeId, entityTransitions.nodeId))
    .leftJoin(sites, eq(sites.id, orionNodes.siteId))
    .where(
      and(
        eq(entityTransitions.kind, 'node'),
        gte(entityTransitions.observedAt, p.start),
        lt(entityTransitions.observedAt, p.end),
      ),
    )
    .groupBy(entityTransitions.nodeId)
    .having(sql`count(*) >= ${p.min}`)
    .orderBy(desc(sql`count(*)`))
    .limit(p.limit);
}

export interface RecurringRow {
  subject: string;
  /** The root device when there is one. */
  nodeId: number | null;
  siteCode: string | null;
  site: string | null;
  incidents: number;
  downMinutes: number;
  /** Newest first. */
  ids: number[];
}

/** Incidents grouped by root device (or site when there is no single device), most first. */
export async function recurringProblems(db: DbOrTx, p: Period): Promise<RecurringRow[]> {
  const subject = sql<string>`coalesce(${orionNodes.caption}, ${sites.name}, 'unknown')`;
  return db
    .select({
      subject,
      nodeId: sql<number | null>`max(${incidents.rootNodeId})::int`,
      siteCode: sql<string | null>`max(${sites.code})`,
      site: sql<string | null>`max(${sites.name})`,
      incidents: sql<number>`count(*)::int`,
      downMinutes: sql<number>`coalesce(sum(extract(epoch from (coalesce(${incidents.resolvedAt}, ${p.end}::timestamptz) - ${incidents.openedAt})) / 60), 0)::int`,
      ids: sql<number[]>`array_agg(${incidents.id} order by ${incidents.id} desc)`,
    })
    .from(incidents)
    .leftJoin(orionNodes, eq(orionNodes.nodeId, incidents.rootNodeId))
    .leftJoin(sites, eq(sites.id, incidents.primarySiteId))
    .where(
      and(
        gte(incidents.openedAt, p.start),
        lt(incidents.openedAt, p.end),
        eq(incidents.seeded, false),
        sql`coalesce(${incidents.resolvedBy}, '') <> 'merged'`,
      ),
    )
    .groupBy(subject)
    .orderBy(desc(sql`count(*)`));
}

export interface NoiseBucket {
  /** "2026-11-19" (day) or "2026-11-19 14:00" (hour), local to the time zone. */
  label: string;
  rawAlerts: number;
  incidents: number;
}

/**
 * Raw alert raises and incidents opened per local hour or day (the headline metric over time).
 * Every bucket in the period is present, zero when nothing happened.
 */
export async function noiseSeries(
  db: DbOrTx,
  p: Period & { timeZone: string; unit: 'hour' | 'day' },
): Promise<NoiseBucket[]> {
  const fmt = p.unit === 'hour' ? 'YYYY-MM-DD HH24:00' : 'YYYY-MM-DD';
  const rawKey = sql<string>`to_char(${entityTransitions.observedAt} AT TIME ZONE ${p.timeZone}, ${fmt})`;
  const incKey = sql<string>`to_char(${incidents.openedAt} AT TIME ZONE ${p.timeZone}, ${fmt})`;
  const raw = await db
    .select({ label: rawKey, n: sql<number>`count(*)::int` })
    .from(entityTransitions)
    .where(
      and(
        eq(entityTransitions.kind, 'alert'),
        inArray(entityTransitions.change, ['raised', 'retriggered']),
        gte(entityTransitions.observedAt, p.start),
        lt(entityTransitions.observedAt, p.end),
        sql`coalesce((${entityTransitions.details}->>'initialSync')::boolean, false) = false`,
      ),
    )
    // By position: the same expression bound twice gets different $n and would not match.
    .groupBy(sql`1`);
  const inc = await db
    .select({ label: incKey, n: sql<number>`count(*)::int` })
    .from(incidents)
    .where(
      and(
        gte(incidents.openedAt, p.start),
        lt(incidents.openedAt, p.end),
        eq(incidents.seeded, false),
      ),
    )
    .groupBy(sql`1`);
  const buckets = new Map<string, NoiseBucket>();
  const step = p.unit === 'hour' ? 3_600_000 : 3_600_000 * 6;
  for (let t = p.start.getTime(); t < p.end.getTime(); t += step) {
    const label = localDateTime(new Date(t), p.timeZone);
    const key = p.unit === 'hour' ? `${label.slice(0, 13)}:00` : label.slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, { label: key, rawAlerts: 0, incidents: 0 });
  }
  for (const r of raw) {
    const b = buckets.get(r.label) ?? { label: r.label, rawAlerts: 0, incidents: 0 };
    buckets.set(r.label, { ...b, rawAlerts: r.n });
  }
  for (const r of inc) {
    const b = buckets.get(r.label) ?? { label: r.label, rawAlerts: 0, incidents: 0 };
    buckets.set(r.label, { ...b, incidents: r.n });
  }
  return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
}
