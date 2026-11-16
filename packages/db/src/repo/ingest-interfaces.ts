import { and, inArray, isNull, sql } from 'drizzle-orm';
import {
  bucketStart,
  chunk,
  diffStatuses,
  normalizeStatus,
  removedIds,
  type StatusNorm,
} from '@mercer/core';
import { interfaceMetrics5m, orionInterfaces, orionNodes } from '../schema';
import type { Db } from '../client';
import { excludedSet, runningAvg, runningMax, UPSERT_CHUNK } from './helpers';
import { insertTransitions, type TransitionInsert } from './transitions';
import type { SnapshotResult } from './ingest-nodes';

/** Structural subset of @mercer/swis SwisInterface. */
export interface InterfaceSnapshotRow {
  interfaceId: number;
  nodeId: number;
  name: string | null;
  caption: string | null;
  fullName: string | null;
  alias: string | null;
  typeDescription: string | null;
  status: number | null;
  operStatus: number | null;
  adminStatus: number | null;
  inPercentUtil: number | null;
  outPercentUtil: number | null;
  inBps: number | null;
  outBps: number | null;
  speedBps: number | null;
  inErrorsHour: number | null;
  outErrorsHour: number | null;
  inDiscardsHour: number | null;
  outDiscardsHour: number | null;
  unmanaged: boolean;
  uri: string | null;
}

const STATUS_CHANGED = sql.raw(
  `"orion_interfaces"."status_norm" IS DISTINCT FROM excluded."status_norm"`,
);

export async function applyInterfaceSnapshot(
  db: Db,
  ifaces: InterfaceSnapshotRow[],
  now: Date,
): Promise<SnapshotResult> {
  return db.transaction(async (tx) => {
    const prevRows = await tx
      .select({
        interfaceId: orionInterfaces.interfaceId,
        status: orionInterfaces.status,
        statusNorm: orionInterfaces.statusNorm,
        removedAt: orionInterfaces.removedAt,
      })
      .from(orionInterfaces);
    const prev = new Map(
      prevRows
        .filter((p) => p.removedAt === null)
        .map((p) => [p.interfaceId, { status: p.status, statusNorm: p.statusNorm as StatusNorm }]),
    );
    const next = ifaces.map((i) => ({
      ...i,
      statusNorm: i.unmanaged ? ('unmanaged' as const) : normalizeStatus(i.status),
    }));
    const changes = diffStatuses(
      prev,
      next.map((i) => ({ id: i.interfaceId, statusNorm: i.statusNorm, status: i.status })),
    );

    for (const part of chunk(next, UPSERT_CHUNK)) {
      await tx
        .insert(orionInterfaces)
        .values(
          part.map((i) => ({
            ...i,
            firstSeenAt: now,
            lastPolledAt: now,
            lastStatusChangeAt: now,
            removedAt: null,
          })),
        )
        .onConflictDoUpdate({
          target: orionInterfaces.interfaceId,
          set: {
            ...excludedSet(orionInterfaces, ['interfaceId', 'firstSeenAt', 'lastStatusChangeAt']),
            lastStatusChangeAt: sql`CASE WHEN ${STATUS_CHANGED} THEN excluded."last_polled_at" ELSE ${orionInterfaces.lastStatusChangeAt} END`,
          },
        });
    }

    const gone = removedIds(
      prev,
      next.map((i) => ({ id: i.interfaceId })),
    );
    for (const part of chunk(gone, 1000)) {
      await tx
        .update(orionInterfaces)
        .set({ removedAt: now })
        .where(and(inArray(orionInterfaces.interfaceId, part), isNull(orionInterfaces.removedAt)));
    }

    const byId = new Map(next.map((i) => [i.interfaceId, i]));
    const nodeIds = [...new Set(changes.map((c) => byId.get(c.id)!.nodeId))];
    const siteByNode = new Map<number, number | null>();
    for (const part of chunk(nodeIds, 1000)) {
      const rows = await tx
        .select({ nodeId: orionNodes.nodeId, siteId: orionNodes.siteId })
        .from(orionNodes)
        .where(inArray(orionNodes.nodeId, part));
      for (const r of rows) siteByNode.set(r.nodeId, r.siteId);
    }
    const rows: TransitionInsert[] = changes.map((c) => {
      const i = byId.get(c.id)!;
      return {
        kind: 'interface',
        change: 'status',
        entityKey: `iface:${c.id}`,
        nodeId: i.nodeId,
        interfaceId: c.id,
        siteId: siteByNode.get(i.nodeId) ?? null,
        fromState: c.from,
        toState: c.to,
        observedAt: now,
        details: {
          caption: i.caption ?? i.name,
          fullName: i.fullName,
          fromCode: c.fromCode,
          toCode: c.toCode,
          operStatus: i.operStatus,
          adminStatus: i.adminStatus,
          ...(c.isNew ? { initialSync: true } : {}),
        },
      };
    });
    await insertTransitions(tx, rows);

    const bucket = bucketStart(now, 5);
    const metricRows = next
      .filter((i) => !i.unmanaged && (i.inPercentUtil !== null || i.outPercentUtil !== null))
      .map((i) => ({
        interfaceId: i.interfaceId,
        bucket,
        samples: 1,
        inUtilAvg: i.inPercentUtil,
        inUtilMax: i.inPercentUtil,
        outUtilAvg: i.outPercentUtil,
        outUtilMax: i.outPercentUtil,
        inBpsAvg: i.inBps,
        outBpsAvg: i.outBps,
        inErrors: i.inErrorsHour,
        outErrors: i.outErrorsHour,
        inDiscards: i.inDiscardsHour,
        outDiscards: i.outDiscardsHour,
      }));
    const T = 'interface_metrics_5m';
    for (const part of chunk(metricRows, UPSERT_CHUNK)) {
      await tx
        .insert(interfaceMetrics5m)
        .values(part)
        .onConflictDoUpdate({
          target: [interfaceMetrics5m.interfaceId, interfaceMetrics5m.bucket],
          set: {
            samples: sql`${interfaceMetrics5m.samples} + 1`,
            inUtilAvg: runningAvg(T, 'in_util_avg'),
            inUtilMax: runningMax(T, 'in_util_max'),
            outUtilAvg: runningAvg(T, 'out_util_avg'),
            outUtilMax: runningMax(T, 'out_util_max'),
            inBpsAvg: runningAvg(T, 'in_bps_avg'),
            outBpsAvg: runningAvg(T, 'out_bps_avg'),
            // "ThisHour" counters only grow within the hour; the max is the bucket's latest value.
            inErrors: runningMax(T, 'in_errors'),
            outErrors: runningMax(T, 'out_errors'),
            inDiscards: runningMax(T, 'in_discards'),
            outDiscards: runningMax(T, 'out_discards'),
          },
        });
    }
    return {
      upserted: next.length,
      removed: gone.length,
      transitions: rows.length,
      metrics: metricRows.length,
    };
  });
}
