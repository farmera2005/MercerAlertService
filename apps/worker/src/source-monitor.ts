import { errorMessage, type Logger } from '@mercer/core';
import {
  getHeartbeat,
  insertTransitions,
  publishEvent,
  upsertHeartbeat,
  type Db,
} from '@mercer/db';
import type { SwisClient } from '@mercer/swis';

export type SourceState = 'up' | 'down' | 'unknown';

/**
 * Decides whether SolarWinds (SWIS) is usable and records `source down/up` transitions.
 * Down = circuit breaker open, or no successful alert poll for SWIS_STALE_AFTER_SEC.
 * Correlation (M2) turns a `source down` transition into the fixed-P1 "Monitoring source down"
 * incident; notifications do not depend on SWIS, so that incident still goes out.
 */
export class SourceMonitor {
  private state: SourceState = 'unknown';
  private lastAlertSuccess: Date | null = null;
  private lastError: string | null = null;
  private readonly startedAt: Date;

  constructor(
    private readonly db: Db,
    private readonly client: SwisClient,
    private readonly staleAfterSec: number,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.startedAt = now();
  }

  get current(): SourceState {
    return this.state;
  }

  /** Restore the last persisted state so restarts don't duplicate transitions. */
  async init(): Promise<void> {
    const hb = await getHeartbeat(this.db, 'swis');
    const s = hb?.details?.state;
    if (s === 'up' || s === 'down') this.state = s;
  }

  recordAlertPollSuccess(at: Date): void {
    this.lastAlertSuccess = at;
    this.lastError = null;
  }

  recordAlertPollFailure(err: unknown): void {
    this.lastError = errorMessage(err);
  }

  /** Evaluate and persist; returns the new state. */
  async evaluate(): Promise<SourceState> {
    const now = this.now();
    const breaker = this.client.breaker.snapshot();
    const staleMs = this.staleAfterSec * 1000;
    const since = this.lastAlertSuccess ?? this.startedAt;
    const stale = now.getTime() - since.getTime() > staleMs;
    let next: SourceState = this.state;
    let reason = '';
    if (breaker.state === 'open') {
      next = 'down';
      reason = `circuit breaker open (${breaker.consecutiveFailures} consecutive failures)`;
    } else if (stale && (this.lastAlertSuccess || this.lastError)) {
      next = 'down';
      reason = this.lastAlertSuccess
        ? `no successful alert poll for ${Math.round((now.getTime() - since.getTime()) / 1000)}s`
        : `SWIS has not answered since worker start`;
    } else if (this.lastAlertSuccess && !stale && breaker.state === 'closed') {
      next = 'up';
      reason = 'alert poll succeeded';
    }

    if (this.state === 'unknown' && next === 'up') {
      // First successful contact after start: nothing changed from the operator's point of view.
      this.state = next;
    } else if (next !== this.state && next !== 'unknown') {
      const prev = this.state;
      this.state = next;
      await insertTransitions(this.db, [
        {
          kind: 'source',
          change: next,
          entityKey: 'source:swis',
          fromState: prev === 'unknown' ? null : prev,
          toState: next,
          observedAt: now,
          details: {
            reason,
            lastError: this.lastError,
            lastSuccessAt: this.lastAlertSuccess?.toISOString() ?? null,
            breaker: breaker.state,
          },
        },
      ]);
      await publishEvent(this.db, { t: 'source', status: next });
      if (next === 'down')
        this.log.error(
          { reason, lastError: this.lastError },
          'MONITORING SOURCE DOWN: SolarWinds SWIS unavailable',
        );
      else this.log.info({ reason }, 'monitoring source recovered: SWIS available');
    }

    const stats = this.client.getStats();
    await upsertHeartbeat(this.db, {
      component: 'swis',
      status: this.state,
      at: now,
      details: {
        state: this.state,
        breaker: breaker.state,
        breakerRetryAt: breaker.retryAt?.toISOString() ?? null,
        lastAlertPollSuccessAt: this.lastAlertSuccess?.toISOString() ?? null,
        lastError: this.lastError ?? stats.lastError,
        tlsVerification: stats.tlsVerification,
        requests: stats.requests,
        failures: stats.failures,
      },
    });
    return this.state;
  }
}
