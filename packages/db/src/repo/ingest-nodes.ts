import { and, inArray, isNull, sql } from 'drizzle-orm';
import {
  bucketStart,
  chunk,
  diffStatuses,
  normalizeStatus,
  removedIds,
  type StatusNorm,
} from '@mercer/core';
import { nodeMetrics5m, orionNodes } from '../schema';
import type { Db } from '../client';
import { excludedSet, runningAvg, runningMax, UPSERT_CHUNK } from './helpers';
import { insertTransitions, type TransitionInsert } from './transitions';

/** Structural subset of @mercer/swis SwisNode plus resolved site/role. */
export interface NodeSnapshotRow {
  nodeId: number;
  caption: string;
  dns: string | null;
  sysName: string | null;
  ipAddress: string | null;
  status: number | null;
  statusDescription: string | null;
  responseTimeMs: number | null;
  percentLoss: number | null;
  cpuLoad: number | null;
  percentMemoryUsed: number | null;
  vendor: string | null;
  machineType: string | null;
  lastBoot: Date | null;
  unmanaged: boolean;
  objectSubType: string | null;
  location: string | null;
  isServer: boolean | null;
  uri: string | null;
  customProperties: Record<string, unknown>;
  siteId: number | null;
  divisionCode: string | null;
  siteSource: string;
  deviceRole: string;
}

export interface SnapshotResult {
  upserted: number;
  removed: number;
  transitions: number;
  metrics: number;
}

const STATUS_CHANGED = sql.raw(
  `"orion_nodes"."status_norm" IS DISTINCT FROM excluded."status_norm"`,
);

export async function applyNodeSnapshot(
  db: Db,
  nodes: NodeSnapshotRow[],
  now: Date,
): Promise<SnapshotResult> {
  return db.transaction(async (tx) => {
    const prevRows = await tx
      .select({
        nodeId: orionNodes.nodeId,
        status: orionNodes.status,
        statusNorm: orionNodes.statusNorm,
        removedAt: orionNodes.removedAt,
      })
      .from(orionNodes);
    const prev = new Map(
      prevRows
        .filter((p) => p.removedAt === null)
        .map((p) => [p.nodeId, { status: p.status, statusNorm: p.statusNorm as StatusNorm }]),
    );
    const next = nodes.map((n) => ({
      ...n,
      statusNorm: n.unmanaged ? ('unmanaged' as const) : normalizeStatus(n.status),
    }));
    const changes = diffStatuses(
      prev,
      next.map((n) => ({ id: n.nodeId, statusNorm: n.statusNorm, status: n.status })),
    );

    for (const part of chunk(next, UPSERT_CHUNK)) {
      await tx
        .insert(orionNodes)
        .values(
          part.map((n) => ({
            ...n,
            firstSeenAt: now,
            lastPolledAt: now,
            lastStatusChangeAt: now,
            removedAt: null,
          })),
        )
        .onConflictDoUpdate({
          target: orionNodes.nodeId,
          set: {
            ...excludedSet(orionNodes, ['nodeId', 'firstSeenAt', 'lastStatusChangeAt']),
            lastStatusChangeAt: sql`CASE WHEN ${STATUS_CHANGED} THEN excluded."last_polled_at" ELSE ${orionNodes.lastStatusChangeAt} END`,
          },
        });
    }

    const gone = removedIds(
      prev,
      next.map((n) => ({ id: n.nodeId })),
    );
    for (const part of chunk(gone, 1000)) {
      await tx
        .update(orionNodes)
        .set({ removedAt: now })
        .where(and(inArray(orionNodes.nodeId, part), isNull(orionNodes.removedAt)));
    }

    const byId = new Map(next.map((n) => [n.nodeId, n]));
    const rows: TransitionInsert[] = changes.map((c) => {
      const n = byId.get(c.id)!;
      return {
        kind: 'node',
        change: 'status',
        entityKey: `node:${c.id}`,
        nodeId: c.id,
        siteId: n.siteId,
        fromState: c.from,
        toState: c.to,
        observedAt: now,
        details: {
          caption: n.caption,
          deviceRole: n.deviceRole,
          fromCode: c.fromCode,
          toCode: c.toCode,
          statusDescription: n.statusDescription,
          ...(c.isNew ? { initialSync: true } : {}),
        },
      };
    });
    await insertTransitions(tx, rows);

    // 5-minute metric rollups (managed nodes with at least one metric).
    const bucket = bucketStart(now, 5);
    const metricRows = next
      .filter(
        (n) =>
          !n.unmanaged &&
          [n.responseTimeMs, n.percentLoss, n.cpuLoad, n.percentMemoryUsed].some((v) => v !== null),
      )
      .map((n) => ({
        nodeId: n.nodeId,
        bucket,
        samples: 1,
        rtAvg: n.responseTimeMs,
        rtMax: n.responseTimeMs,
        lossAvg: n.percentLoss,
        lossMax: n.percentLoss,
        cpuAvg: n.cpuLoad,
        cpuMax: n.cpuLoad,
        memAvg: n.percentMemoryUsed,
        memMax: n.percentMemoryUsed,
      }));
    const T = 'node_metrics_5m';
    for (const part of chunk(metricRows, UPSERT_CHUNK)) {
      await tx
        .insert(nodeMetrics5m)
        .values(part)
        .onConflictDoUpdate({
          target: [nodeMetrics5m.nodeId, nodeMetrics5m.bucket],
          set: {
            samples: sql`${nodeMetrics5m.samples} + 1`,
            rtAvg: runningAvg(T, 'rt_avg'),
            rtMax: runningMax(T, 'rt_max'),
            lossAvg: runningAvg(T, 'loss_avg'),
            lossMax: runningMax(T, 'loss_max'),
            cpuAvg: runningAvg(T, 'cpu_avg'),
            cpuMax: runningMax(T, 'cpu_max'),
            memAvg: runningAvg(T, 'mem_avg'),
            memMax: runningMax(T, 'mem_max'),
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
