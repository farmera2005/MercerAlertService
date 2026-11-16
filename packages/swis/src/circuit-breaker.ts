import { EventEmitter } from 'node:events';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: Date | null;
  retryAt: Date | null;
}

/**
 * Classic three-state breaker. One logical SWIS call (after its own retries) is one sample.
 * Emits `state` with (next, prev) on every transition.
 */
export class CircuitBreaker extends EventEmitter<{ state: [BreakerState, BreakerState] }> {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt: number | null = null;
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly opts: BreakerOptions) {
    super();
    this.now = opts.now ?? Date.now;
  }

  /** Returns true if a call may proceed. In half-open, only one probe is allowed at a time. */
  tryAcquire(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.openedAt !== null && this.now() - this.openedAt >= this.opts.cooldownMs) {
        this.transition('half_open');
      } else {
        return false;
      }
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.probeInFlight = false;
    this.failures = 0;
    if (this.state !== 'closed') {
      this.openedAt = null;
      this.transition('closed');
    }
  }

  onFailure(): void {
    this.probeInFlight = false;
    this.failures += 1;
    if (
      this.state === 'half_open' ||
      (this.state === 'closed' && this.failures >= this.opts.failureThreshold)
    ) {
      this.openedAt = this.now();
      this.transition('open');
    }
  }

  /** A call that failed for a non-availability reason (e.g. bad SWQL) — releases a probe slot. */
  onNeutral(): void {
    this.probeInFlight = false;
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.failures,
      openedAt: this.openedAt === null ? null : new Date(this.openedAt),
      retryAt: this.openedAt === null ? null : new Date(this.openedAt + this.opts.cooldownMs),
    };
  }

  private transition(next: BreakerState): void {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.emit('state', next, prev);
  }
}
