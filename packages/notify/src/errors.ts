/** A delivery failed. `retryable` decides whether the outbox tries again with backoff. */
export class NotifyError extends Error {
  override name = 'NotifyError';
  constructor(
    message: string,
    readonly provider: 'teams' | 'twilio' | 'pushover',
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** Timeouts, throttling and server errors are worth retrying; a rejected request is not. */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
