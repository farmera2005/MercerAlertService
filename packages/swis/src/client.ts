import { Agent, request, errors as undiciErrors } from 'undici';
import { backoffDelay, createLogger, sleep, type Logger } from '@mercer/core';
import { CircuitBreaker, type BreakerSnapshot, type BreakerState } from './circuit-breaker';
import {
  CircuitOpenError,
  SwisError,
  SwisHttpError,
  SwisNetworkError,
  SwisSchemaError,
  SwisTimeoutError,
} from './errors';
import { buildTlsConnectOptions, INSECURE_TLS_WARNING } from './tls';

export type SwisRow = Record<string, unknown>;
export type SwisParams = Record<string, string | number | boolean | null>;

export interface SwisClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  caCertPath?: string;
  tlsServername?: string;
  insecureSkipVerify?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  userAgent?: string;
  logger?: Logger;
}

export interface CallOptions {
  /** Short name for logs/metrics, e.g. "activeAlerts". */
  label?: string;
  timeoutMs?: number;
  /** Override retry count for this call (e.g. 0 for discovery probes). */
  retries?: number;
  signal?: AbortSignal;
}

export interface SwisClientStats {
  breaker: BreakerSnapshot;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  requests: number;
  failures: number;
  tlsVerification: 'enabled' | 'DISABLED';
}

const QUERY_PATH = '/SolarWinds/InformationService/v3/Json/Query';
const INVOKE_PATH = '/SolarWinds/InformationService/v3/Json/Invoke';
const INSECURE_REMINDER_MS = 10 * 60_000;
const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Typed SWIS REST client: Basic auth, custom CA, per-request timeout, retries with jittered
 * exponential backoff, and a circuit breaker around each logical call.
 */
export class SwisClient {
  readonly breaker: CircuitBreaker;
  private readonly agent: Agent;
  private readonly authHeader: string;
  private readonly log: Logger;
  private readonly o: Required<
    Pick<SwisClientOptions, 'timeoutMs' | 'maxRetries' | 'retryBaseMs' | 'retryMaxMs' | 'userAgent'>
  >;
  private readonly insecure: boolean;
  private lastInsecureReminder = 0;
  private stats = {
    lastSuccessAt: null as Date | null,
    lastFailureAt: null as Date | null,
    lastError: null as string | null,
    requests: 0,
    failures: 0,
  };

  constructor(private readonly opts: SwisClientOptions) {
    this.log = opts.logger ?? createLogger('swis');
    this.o = {
      timeoutMs: opts.timeoutMs ?? 20_000,
      maxRetries: opts.maxRetries ?? 3,
      retryBaseMs: opts.retryBaseMs ?? 500,
      retryMaxMs: opts.retryMaxMs ?? 8_000,
      userAgent: opts.userAgent ?? 'MercerAlertService',
    };
    this.insecure = !!opts.insecureSkipVerify;
    const isHttps = opts.baseUrl.startsWith('https:');
    if (!isHttps)
      this.log.warn(
        { baseUrl: opts.baseUrl },
        'SWIS base URL is plain HTTP (expected only for mock-swis)',
      );
    const tls = isHttps
      ? buildTlsConnectOptions(
          {
            caCertPath: opts.caCertPath,
            tlsServername: opts.tlsServername,
            insecureSkipVerify: this.insecure,
          },
          this.log,
        )
      : undefined;
    this.agent = new Agent({
      connect: tls,
      keepAliveTimeout: 30_000,
      connections: 4,
      headersTimeout: this.o.timeoutMs,
      bodyTimeout: this.o.timeoutMs,
    });
    this.authHeader =
      'Basic ' + Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
    this.breaker = new CircuitBreaker({
      failureThreshold: opts.breakerThreshold ?? 5,
      cooldownMs: opts.breakerCooldownMs ?? 30_000,
    });
    this.breaker.on('state', (next: BreakerState, prev: BreakerState) => {
      const level = next === 'open' ? 'error' : 'warn';
      this.log[level]({ breaker: next, prev }, `SWIS circuit breaker ${prev} → ${next}`);
    });
  }

  /** Run a SWQL query and return its `results` rows. */
  async query<T extends SwisRow = SwisRow>(
    swql: string,
    params: SwisParams = {},
    call: CallOptions = {},
  ): Promise<T[]> {
    const body = await this.call(QUERY_PATH, { query: swql, parameters: params }, call);
    if (
      !body ||
      typeof body !== 'object' ||
      !Array.isArray((body as { results?: unknown }).results)
    ) {
      throw new SwisSchemaError(`SWIS response for ${call.label ?? 'query'} has no results array`);
    }
    return (body as { results: T[] }).results;
  }

  /**
   * Page through a snapshot query with `WITH ROWS start TO end`. `build(start, end)` must return
   * SWQL ordered by a unique key. Stops at the first short page.
   */
  async queryAllPages<T extends SwisRow = SwisRow>(
    build: (start: number, end: number) => string,
    params: SwisParams,
    pageSize: number,
    call: CallOptions & { maxPages?: number } = {},
  ): Promise<T[]> {
    const all: T[] = [];
    const maxPages = call.maxPages ?? 500;
    for (let page = 0; page < maxPages; page++) {
      const start = page * pageSize + 1;
      const rows = await this.query<T>(build(start, start + pageSize - 1), params, {
        ...call,
        label: `${call.label ?? 'query'}#${page + 1}`,
      });
      all.push(...rows);
      if (rows.length < pageSize) return all;
    }
    throw new SwisSchemaError(
      `${call.label ?? 'query'}: exceeded ${maxPages} pages — refusing to continue`,
    );
  }

  /**
   * Incremental fetch: `build(pageSize)` must contain `WHERE <id> > @cursor ORDER BY <id>
   * WITH ROWS 1 TO <pageSize>`. Advances the cursor from `cursorField` of the last row.
   */
  async queryIncremental<T extends SwisRow = SwisRow>(
    build: (pageSize: number) => string,
    cursorField: string,
    startCursor: number,
    pageSize: number,
    call: CallOptions & { maxPages?: number; params?: SwisParams } = {},
  ): Promise<{ rows: T[]; cursor: number }> {
    let cursor = startCursor;
    const all: T[] = [];
    const maxPages = call.maxPages ?? 50;
    for (let page = 0; page < maxPages; page++) {
      const rows = await this.query<T>(
        build(pageSize),
        { ...call.params, cursor },
        {
          ...call,
          label: `${call.label ?? 'incremental'}#${page + 1}`,
        },
      );
      all.push(...rows);
      const last = rows.at(-1);
      if (last) {
        const next = Number(last[cursorField]);
        if (!Number.isFinite(next) || next <= cursor) {
          throw new SwisSchemaError(`${call.label}: cursor field ${cursorField} did not advance`);
        }
        cursor = next;
      }
      if (rows.length < pageSize) break;
    }
    return { rows: all, cursor };
  }

  /** Invoke a SWIS verb, e.g. invoke('Orion.AlertActive', 'Acknowledge', [[1,2], 'note']). */
  async invoke(
    entity: string,
    verb: string,
    args: unknown[],
    call: CallOptions = {},
  ): Promise<unknown> {
    if (!/^[A-Za-z0-9_.]+$/.test(entity) || !/^[A-Za-z0-9_]+$/.test(verb)) {
      throw new Error('invalid SWIS entity/verb name');
    }
    return this.call(`${INVOKE_PATH}/${entity}/${verb}`, args, {
      retries: 0,
      ...call,
      label: call.label ?? `${entity}.${verb}`,
    });
  }

  getStats(): SwisClientStats {
    return {
      ...this.stats,
      breaker: this.breaker.snapshot(),
      tlsVerification: this.insecure ? 'DISABLED' : 'enabled',
    };
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  // -------------------------------------------------------------------------------------------

  private async call(path: string, payload: unknown, call: CallOptions): Promise<unknown> {
    this.remindIfInsecure();
    if (!this.breaker.tryAcquire()) {
      const snap = this.breaker.snapshot();
      throw new CircuitOpenError(snap.retryAt ?? new Date());
    }
    const retries = call.retries ?? this.o.maxRetries;
    let attempt = 0;
    for (;;) {
      try {
        this.stats.requests++;
        const result = await this.once(path, payload, call);
        this.breaker.onSuccess();
        this.stats.lastSuccessAt = new Date();
        return result;
      } catch (err) {
        const e = toSwisError(err, call.timeoutMs ?? this.o.timeoutMs);
        const retryable = e instanceof SwisHttpError ? e.retryable : e.availability;
        if (retryable && attempt < retries && !call.signal?.aborted) {
          const delay = backoffDelay(attempt, this.o.retryBaseMs, this.o.retryMaxMs);
          this.log.warn(
            { label: call.label, attempt: attempt + 1, delay, err: e.message },
            'SWIS call failed; retrying',
          );
          attempt++;
          await sleep(delay, call.signal);
          continue;
        }
        this.stats.failures++;
        this.stats.lastFailureAt = new Date();
        this.stats.lastError = e.message;
        if (e.availability) this.breaker.onFailure();
        else this.breaker.onNeutral();
        throw e;
      }
    }
  }

  private async once(path: string, payload: unknown, call: CallOptions): Promise<unknown> {
    const timeoutMs = call.timeoutMs ?? this.o.timeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
    const started = Date.now();
    const res = await request(this.opts.baseUrl + path, {
      method: 'POST',
      dispatcher: this.agent,
      signal,
      headers: {
        authorization: this.authHeader,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': this.o.userAgent,
      },
      body: JSON.stringify(payload),
    }).catch((err: unknown) => {
      if (timeout.aborted) throw new SwisTimeoutError(timeoutMs);
      throw err;
    });
    const text = await res.body.text().catch((err: unknown) => {
      if (timeout.aborted) throw new SwisTimeoutError(timeoutMs);
      throw err;
    });
    this.log.debug(
      { label: call.label, status: res.statusCode, ms: Date.now() - started, bytes: text.length },
      'SWIS call',
    );
    if (res.statusCode >= 400) {
      let message = text.slice(0, 500) || `HTTP ${res.statusCode}`;
      let exceptionType: string | undefined;
      try {
        const j = JSON.parse(text) as { Message?: string; ExceptionType?: string };
        if (j.Message) message = j.Message;
        exceptionType = j.ExceptionType;
      } catch {
        /* not JSON */
      }
      throw new SwisHttpError(res.statusCode, message, exceptionType);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new SwisSchemaError(`SWIS returned non-JSON for ${call.label ?? path}`);
    }
  }

  private remindIfInsecure(): void {
    if (!this.insecure) return;
    const now = Date.now();
    if (now - this.lastInsecureReminder >= INSECURE_REMINDER_MS) {
      this.lastInsecureReminder = now;
      this.log.error({ security: true }, INSECURE_TLS_WARNING);
    }
  }
}

function toSwisError(err: unknown, timeoutMs: number): SwisError {
  if (err instanceof SwisError) return err;
  if (
    err instanceof undiciErrors.HeadersTimeoutError ||
    err instanceof undiciErrors.BodyTimeoutError
  ) {
    return new SwisTimeoutError(timeoutMs);
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new SwisTimeoutError(timeoutMs);
  }
  const code = (err as { code?: string } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  const hint =
    code && TLS_ERROR_CODES.has(code)
      ? ' — Orion certificate not trusted; set SWIS_CA_CERT_PATH (see README)'
      : '';
  return new SwisNetworkError(`SWIS unreachable: ${msg}${code ? ` (${code})` : ''}${hint}`, {
    cause: err,
  });
}
