export class SwisError extends Error {
  override name = 'SwisError';
  /** Whether this failure means "SWIS unavailable" (counts toward the circuit breaker). */
  readonly availability: boolean;
  constructor(message: string, availability: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.availability = availability;
  }
}

/** Non-2xx HTTP response. 400 = bad SWQL (our bug, not an outage); 401/403 = credentials. */
export class SwisHttpError extends SwisError {
  override name = 'SwisHttpError';
  constructor(
    readonly status: number,
    message: string,
    readonly exceptionType?: string,
  ) {
    super(`SWIS HTTP ${status}: ${message}`, status !== 400 && status !== 404);
  }
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export class SwisNetworkError extends SwisError {
  override name = 'SwisNetworkError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, true, options);
  }
}

export class SwisTimeoutError extends SwisError {
  override name = 'SwisTimeoutError';
  constructor(timeoutMs: number) {
    super(`SWIS request timed out after ${timeoutMs} ms`, true);
  }
}

export class CircuitOpenError extends SwisError {
  override name = 'CircuitOpenError';
  constructor(readonly retryAt: Date) {
    super(`SWIS circuit breaker open until ${retryAt.toISOString()}`, true);
  }
}

/** Response shape or required fields do not match what we expect (schema drift). */
export class SwisSchemaError extends SwisError {
  override name = 'SwisSchemaError';
  constructor(message: string) {
    super(message, false);
  }
}
