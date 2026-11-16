import { eq, sql } from 'drizzle-orm';
import { pollerState, pollRuns } from '../schema';
import type { DbOrTx } from '../client';

export type PollerName = 'alerts' | 'nodes' | 'interfaces' | 'events' | 'topology';
export type PollerStateRow = typeof pollerState.$inferSelect;

export async function getPollerState(
  db: DbOrTx,
  poller: string,
): Promise<PollerStateRow | undefined> {
  const [row] = await db.select().from(pollerState).where(eq(pollerState.poller, poller));
  return row;
}

export async function listPollerStates(db: DbOrTx): Promise<PollerStateRow[]> {
  return db.select().from(pollerState).orderBy(pollerState.poller);
}

export interface PollOutcome {
  poller: string;
  startedAt: Date;
  finishedAt: Date;
  status: 'ok' | 'error' | 'skipped';
  rowCount?: number;
  transitionCount?: number;
  error?: string;
  /** Merged into poller_state.cursor on success. */
  cursor?: Record<string, unknown>;
}

/** Record a poll run and fold it into poller_state. */
export async function recordPollOutcome(db: DbOrTx, o: PollOutcome): Promise<void> {
  const durationMs = o.finishedAt.getTime() - o.startedAt.getTime();
  await db.insert(pollRuns).values({
    poller: o.poller,
    startedAt: o.startedAt,
    finishedAt: o.finishedAt,
    status: o.status,
    rowCount: o.rowCount ?? 0,
    transitionCount: o.transitionCount ?? 0,
    durationMs,
    error: o.error?.slice(0, 2000),
  });
  const ok = o.status === 'ok';
  await db
    .insert(pollerState)
    .values({
      poller: o.poller,
      lastStartedAt: o.startedAt,
      lastSuccessAt: ok ? o.finishedAt : null,
      lastErrorAt: ok ? null : o.finishedAt,
      lastError: ok ? null : (o.error ?? o.status),
      consecutiveFailures: ok ? 0 : 1,
      lastDurationMs: durationMs,
      lastRowCount: o.rowCount ?? null,
      cursor: o.cursor ?? {},
      updatedAt: o.finishedAt,
    })
    .onConflictDoUpdate({
      target: pollerState.poller,
      set: ok
        ? {
            lastStartedAt: o.startedAt,
            lastSuccessAt: o.finishedAt,
            consecutiveFailures: 0,
            lastDurationMs: durationMs,
            lastRowCount: o.rowCount ?? null,
            cursor: sql`${pollerState.cursor} || ${JSON.stringify(o.cursor ?? {})}::jsonb`,
            updatedAt: o.finishedAt,
          }
        : {
            lastStartedAt: o.startedAt,
            lastErrorAt: o.finishedAt,
            lastError: (o.error ?? o.status).slice(0, 2000),
            consecutiveFailures: sql`${pollerState.consecutiveFailures} + 1`,
            lastDurationMs: durationMs,
            updatedAt: o.finishedAt,
          },
    });
}
