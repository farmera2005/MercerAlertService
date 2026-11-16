import { errorMessage } from '@mercer/core';
import { publishEvent, recordPollOutcome } from '@mercer/db';
import { CircuitOpenError } from '@mercer/swis';
import type { WorkerContext } from '../context';

export interface PollSummary {
  rows: number;
  transitions: number;
  cursor?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export type PollFn = (ctx: WorkerContext, startedAt: Date) => Promise<PollSummary>;

/**
 * Run one poll and record its outcome. Poll failures are recorded (poller_state, poll_runs) and
 * swallowed: the next tick is the retry, so pg-boss retries would only pile up stale work.
 */
export async function runPoll(
  ctx: WorkerContext,
  poller: string,
  fn: PollFn,
): Promise<PollSummary | null> {
  const startedAt = ctx.now();
  try {
    const s = await fn(ctx, startedAt);
    const finishedAt = ctx.now();
    await recordPollOutcome(ctx.db, {
      poller,
      startedAt,
      finishedAt,
      status: 'ok',
      rowCount: s.rows,
      transitionCount: s.transitions,
      cursor: s.cursor,
    });
    await publishEvent(ctx.db, { t: 'poll', poller, ok: true, transitions: s.transitions });
    const log = s.transitions > 0 ? ctx.log.info.bind(ctx.log) : ctx.log.debug.bind(ctx.log);
    log(
      {
        poller,
        rows: s.rows,
        transitions: s.transitions,
        ms: finishedAt.getTime() - startedAt.getTime(),
        ...s.details,
      },
      'poll ok',
    );
    if (s.transitions > 0) await ctx.onTransitions(poller, s.transitions);
    return s;
  } catch (err) {
    const skipped = err instanceof CircuitOpenError;
    const message = errorMessage(err);
    await recordPollOutcome(ctx.db, {
      poller,
      startedAt,
      finishedAt: ctx.now(),
      status: skipped ? 'skipped' : 'error',
      error: message,
    }).catch((e: unknown) =>
      ctx.log.error({ err: errorMessage(e) }, 'could not record poll outcome'),
    );
    await publishEvent(ctx.db, { t: 'poll', poller, ok: false }).catch(() => {});
    if (skipped) ctx.log.warn({ poller }, 'poll skipped: SWIS circuit open');
    else ctx.log.error({ poller, err: message }, 'poll failed');
    return null;
  }
}
