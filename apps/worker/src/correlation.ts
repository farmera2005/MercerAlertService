import { sql } from 'drizzle-orm';
import {
  runCorrelation,
  type AppConfig,
  type CorrelationConfig,
  type TransitionIn,
} from '@mercer/core';
import {
  buildReconcileTransitions,
  loadCorrelationSnapshot,
  loadPendingTransitions,
  persistCorrelation,
  publishEvent,
  type Db,
} from '@mercer/db';
import type { WorkerContext } from './context';

export const CORRELATE_QUEUE = 'correlate.run';
export const CORRELATE_TICK_SEC = 30;
const LOCK_KEY = 4_204_202_603;
const BATCH = 2000;

export function correlationConfig(cfg: AppConfig): CorrelationConfig {
  return { ...cfg.correlation, timezone: cfg.timezone, scoring: cfg.scoring };
}

export interface CycleSummary {
  runs: number;
  processed: number;
  opened: number;
  touched: number;
  material: number;
  reconciled: number;
}

async function runOnce(
  db: Db,
  ctx: WorkerContext,
  now: Date,
  extra: TransitionIn[] | 'reconcile' | null,
) {
  return db.transaction(async (tx) => {
    // One correlator at a time, even with several worker replicas.
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEY})`);
    const pending = extra === 'reconcile' ? [] : await loadPendingTransitions(tx, BATCH);
    const synthetic =
      extra === 'reconcile' ? await buildReconcileTransitions(tx, now) : (extra ?? []);
    const transitions = [...pending, ...synthetic];
    const input = await loadCorrelationSnapshot(tx, {
      now,
      config: correlationConfig(ctx.cfg),
      transitions,
    });
    const out = runCorrelation(input);
    const res = await persistCorrelation(tx, out, now);
    for (const [ref, id] of res.created) {
      await publishEvent(tx, { t: 'incident', id, change: 'opened' });
      void ref;
    }
    for (const id of res.materialIncidentIds) {
      if (![...res.created.values()].includes(id))
        await publishEvent(tx, { t: 'incident', id, change: 'material' });
    }
    return { pending: pending.length, synthetic: synthetic.length, res, out };
  });
}

/**
 * Process all pending transitions (in batches) and run lifecycle timers. With `reconcile`, finish
 * by aligning alert records with the current Orion mirror (after an upgrade or a long gap).
 */
export async function runCorrelationCycle(
  ctx: WorkerContext,
  opts: { reconcile?: boolean } = {},
): Promise<CycleSummary> {
  const sum: CycleSummary = {
    runs: 0,
    processed: 0,
    opened: 0,
    touched: 0,
    material: 0,
    reconciled: 0,
  };
  const fold = (r: Awaited<ReturnType<typeof runOnce>>) => {
    sum.runs++;
    sum.processed += r.pending;
    sum.opened += r.res.created.size;
    sum.touched += r.res.touchedIncidentIds.length;
    sum.material += r.res.materialIncidentIds.length;
  };
  for (let i = 0; i < 50; i++) {
    const r = await runOnce(ctx.db, ctx, ctx.now(), null);
    fold(r);
    if (r.pending < BATCH) break;
  }
  if (opts.reconcile) {
    const r = await runOnce(ctx.db, ctx, ctx.now(), 'reconcile');
    fold(r);
    sum.reconciled = r.synthetic;
  }
  if (sum.processed || sum.opened || sum.material || sum.reconciled) {
    ctx.log.info({ ...sum }, 'correlation cycle');
  }
  return sum;
}
