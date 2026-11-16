import { inArray } from 'drizzle-orm';
import { diffActiveAlerts, type AlertChange } from '@mercer/core';
import { orionActiveAlerts, orionNodes } from '../schema';
import type { Db } from '../client';
import { excludedSet, UPSERT_CHUNK } from './helpers';
import { insertTransitions, type TransitionInsert } from './transitions';
import { chunk } from '@mercer/core';

/** Structural subset of @mercer/swis SwisActiveAlert. */
export interface ActiveAlertSnapshotRow {
  alertActiveId: number;
  alertObjectId: number;
  alertId: number;
  alertName: string;
  severity: number;
  objectType: string | null;
  triggeredAt: Date | null;
  message: string | null;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  entityUri: string;
  entityType: string;
  entityCaption: string | null;
  relatedNodeId: number | null;
  relatedNodeCaption: string | null;
  nodeId: number | null;
  interfaceId: number | null;
  triggerCount: number | null;
}

export interface AlertSnapshotResult {
  active: number;
  changes: Record<AlertChange['change'], number>;
  transitions: number;
}

const STATE: Record<AlertChange['change'], [string | null, string]> = {
  raised: [null, 'active'],
  retriggered: ['cleared', 'active'],
  cleared: ['active', 'cleared'],
  acked: ['unacked', 'acked'],
  unacked: ['acked', 'unacked'],
};

/**
 * Replace the active-alert mirror with a COMPLETE snapshot and record transitions, atomically.
 * Never call this with a partial fetch.
 */
export async function applyActiveAlertSnapshot(
  db: Db,
  alerts: ActiveAlertSnapshotRow[],
  now: Date,
  opts: { initialSync: boolean },
): Promise<AlertSnapshotResult> {
  return db.transaction(async (tx) => {
    const prev = await tx.select().from(orionActiveAlerts);
    const changes = diffActiveAlerts(
      prev.map((p) => ({
        alertActiveId: p.alertActiveId,
        alertObjectId: p.alertObjectId,
        acknowledged: p.acknowledged,
      })),
      alerts,
    );

    const nodeIds = [
      ...new Set(
        alerts
          .map((a) => a.nodeId)
          .concat(prev.map((p) => p.nodeId))
          .filter((x): x is number => x !== null),
      ),
    ];
    const siteByNode = new Map<number, number | null>();
    for (const part of chunk(nodeIds, 1000)) {
      const rows = await tx
        .select({ nodeId: orionNodes.nodeId, siteId: orionNodes.siteId })
        .from(orionNodes)
        .where(inArray(orionNodes.nodeId, part));
      for (const r of rows) siteByNode.set(r.nodeId, r.siteId);
    }
    const siteOf = (nodeId: number | null) =>
      nodeId === null ? null : (siteByNode.get(nodeId) ?? null);

    // Upsert current snapshot.
    for (const part of chunk(alerts, UPSERT_CHUNK)) {
      await tx
        .insert(orionActiveAlerts)
        .values(
          part.map((a) => ({
            ...a,
            siteId: siteOf(a.nodeId),
            firstSeenAt: now,
            lastSeenAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: orionActiveAlerts.alertActiveId,
          set: excludedSet(orionActiveAlerts, ['alertActiveId', 'firstSeenAt']),
        });
    }
    const nextIds = new Set(alerts.map((a) => a.alertActiveId));
    const goneIds = prev.filter((p) => !nextIds.has(p.alertActiveId)).map((p) => p.alertActiveId);
    for (const part of chunk(goneIds, 1000)) {
      await tx.delete(orionActiveAlerts).where(inArray(orionActiveAlerts.alertActiveId, part));
    }

    // Transitions.
    const nextById = new Map(alerts.map((a) => [a.alertActiveId, a]));
    const prevById = new Map(prev.map((p) => [p.alertActiveId, p]));
    const counts: AlertSnapshotResult['changes'] = {
      raised: 0,
      retriggered: 0,
      cleared: 0,
      acked: 0,
      unacked: 0,
    };
    const rows: TransitionInsert[] = [];
    for (const c of changes) {
      counts[c.change]++;
      const a = nextById.get(c.alertActiveId) ?? prevById.get(c.alertActiveId);
      if (!a) continue;
      const [fromState, toState] = STATE[c.change];
      rows.push({
        kind: 'alert',
        change: c.change,
        entityKey: `alert:${c.alertObjectId}`,
        nodeId: a.nodeId,
        interfaceId: a.interfaceId,
        siteId: siteOf(a.nodeId),
        alertObjectId: c.alertObjectId,
        alertActiveId: c.alertActiveId,
        fromState,
        toState,
        observedAt: now,
        sourceAt:
          c.change === 'acked' ? a.acknowledgedAt : c.change === 'cleared' ? null : a.triggeredAt,
        details: {
          alertId: a.alertId,
          alertName: a.alertName,
          severity: a.severity,
          entityType: a.entityType,
          entityUri: a.entityUri,
          entityCaption: a.entityCaption,
          message: a.message?.slice(0, 1000) ?? null,
          ...(c.previousAlertActiveId ? { previousAlertActiveId: c.previousAlertActiveId } : {}),
          ...(c.change === 'acked' ? { acknowledgedBy: a.acknowledgedBy } : {}),
          ...(opts.initialSync && c.change === 'raised' ? { initialSync: true } : {}),
        },
      });
    }
    await insertTransitions(tx, rows);
    return { active: alerts.length, changes: counts, transitions: rows.length };
  });
}
