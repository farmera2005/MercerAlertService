/**
 * The only place MAS calls Claude. Every call is budget-gated, redacted, logged with tokens,
 * latency and estimated cost, bounded by a timeout, and checked twice (JSON schema on the API
 * side, Zod here). An invalid answer gets one retry; anything else falls back to the template
 * and the caller carries on. Nothing waits on this before a notification goes out.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import {
  budgetState,
  errorMessage,
  estimateCostUsd,
  retryNote,
  startOfZonedDay,
  type AppConfig,
  type BudgetState,
  type Logger,
  type PromptParts,
  type Redactor,
} from '@mercer/core';

export type AiPurpose = 'severity' | 'summary' | 'digest_daily' | 'digest_weekly' | 'test' | 'chat';
export type AiCallStatus = 'ok' | 'retried' | 'fallback' | 'error' | 'refused' | 'budget_blocked';
export type Effort = 'low' | 'medium' | 'high';

/** Where calls are logged and the budget is read (the worker wires these to the database). */
export interface AiStore {
  spendSince(since: Date): Promise<number>;
  record(row: AiCallRecord): Promise<number>;
}

export interface AiCallRecord {
  at: Date;
  purpose: AiPurpose;
  model: string;
  incidentId: number | null;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  costUsd: number;
  status: AiCallStatus;
  stopReason: string | null;
  servedBy: string | null;
  error: string | null;
  redacted: boolean;
  requestId: string | null;
}

export interface StructuredCall<T> {
  purpose: AiPurpose;
  model: string;
  effort: Effort;
  maxTokens: number;
  prompt: PromptParts;
  schema: z.ZodType<T>;
  redactor: Redactor;
  incidentId?: number | null;
  /** Semantic check after the schema (e.g. digest citations); returns a problem or null. */
  check?: (data: T) => string | null;
  /** Overrides the configured timeout (digests get longer). */
  timeoutMs?: number;
}

export type CallOutcome<T> =
  | {
      ok: true;
      /** Placeholders already restored. */
      data: T;
      status: 'ok' | 'retried';
      callId: number;
      model: string;
      costUsd: number;
      budget: BudgetState;
    }
  | {
      ok: false;
      status: Exclude<AiCallStatus, 'ok' | 'retried'>;
      /** Worth trying again later (API down, timeout, rate limit, budget until midnight). */
      transient: boolean;
      error: string;
      callId: number;
      budget: BudgetState;
    };

/** Opus, Sonnet and Fable decline some requests for policy reasons; let the API reroute them. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AiRunnerDeps {
  cfg: AppConfig['ai'];
  timeZone: string;
  store: AiStore;
  log: Logger;
  now: () => Date;
  /** Injected in tests; built from cfg otherwise. */
  client?: Anthropic;
}

export function createAnthropicClient(cfg: AppConfig['ai']): Anthropic {
  return new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs,
    // One SDK-level retry for 429/5xx/connection errors; the job's own backoff does the rest.
    maxRetries: 1,
  });
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Classify an SDK error: transient errors are retried later, others give up on this change. */
export function isTransient(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true; // 5xx incl. 529 overloaded
  if (err instanceof Anthropic.APIError && err.status === 408) return true;
  return false;
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timed out';
  if (err instanceof Anthropic.APIError && err.status) {
    const body = err.error as { error?: { type?: string; message?: string } } | undefined;
    const type = body?.error?.type ?? err.name;
    return `${err.status} ${type}: ${(body?.error?.message ?? err.message).slice(0, 300)}`;
  }
  return errorMessage(err).slice(0, 300);
}

export class AiRunner {
  /** Shared with the chat loop (chat.ts), which logs and budgets through the same deps. */
  readonly client: Anthropic;

  constructor(readonly d: AiRunnerDeps) {
    this.client = d.client ?? createAnthropicClient(d.cfg);
  }

  async budget(): Promise<BudgetState> {
    const since = startOfZonedDay(this.d.now(), this.d.timeZone);
    return budgetState(await this.d.store.spendSince(since), this.d.cfg.dailyBudgetUsd);
  }

  async call<T>(c: StructuredCall<T>): Promise<CallOutcome<T>> {
    const started = this.d.now();
    const before = await this.budget();
    const base = {
      at: started,
      purpose: c.purpose,
      model: c.model,
      incidentId: c.incidentId ?? null,
      redacted: c.redactor.enabled,
    };
    if (before.level === 'exhausted') {
      const callId = await this.d.store.record({
        ...base,
        attempts: 0,
        ...ZERO,
        latencyMs: 0,
        costUsd: 0,
        status: 'budget_blocked',
        stopReason: null,
        servedBy: null,
        error: `daily budget of US$${this.d.cfg.dailyBudgetUsd} reached`,
        requestId: null,
      });
      return {
        ok: false,
        status: 'budget_blocked',
        transient: true,
        error: 'daily AI budget reached',
        callId,
        budget: before,
      };
    }

    // Stable prefix first, so its placeholders are numbered the same in every call (cache hits).
    const stable = c.redactor.redact(c.prompt.stable);
    const task = c.redactor.redact(c.prompt.task);
    const user = c.redactor.redact(c.prompt.user);
    const format = betaZodOutputFormat(c.schema);

    const usage: Usage = { ...ZERO };
    let attempts = 0;
    let problem: string | null = null;
    let stopReason: string | null = null;
    let servedBy: string | null = null;
    let requestId: string | null = null;
    let cost = 0;
    let lastError: unknown = null;
    let refused = false;
    let result: T | null = null;

    for (let attempt = 1; attempt <= 2 && result === null && !refused; attempt++) {
      attempts = attempt;
      const content: Anthropic.Beta.BetaTextBlockParam[] = [{ type: 'text', text: user }];
      if (problem) content.push({ type: 'text', text: retryNote(problem) });
      try {
        const msg = await this.client.beta.messages.create(
          {
            model: c.model,
            // A truncated first answer gets twice the room on the retry.
            max_tokens: problem?.startsWith('the answer was cut off')
              ? c.maxTokens * 2
              : c.maxTokens,
            betas: [FALLBACK_BETA],
            fallbacks: 'default',
            output_config: { effort: c.effort, format },
            system: [
              { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
              { type: 'text', text: task },
            ],
            messages: [{ role: 'user', content }],
          },
          { timeout: c.timeoutMs ?? this.d.cfg.timeoutMs },
        );
        requestId = msg._request_id ?? requestId;
        const u = msg.usage;
        const thisUsage: Usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        };
        for (const k of Object.keys(usage) as Array<keyof Usage>) usage[k] += thisUsage[k];
        // Bill at the model that actually answered (a server-side fallback may have run).
        cost += estimateCostUsd(msg.model, thisUsage);
        if (msg.model !== c.model) servedBy = msg.model;
        stopReason = msg.stop_reason ?? null;
        lastError = null;

        if (msg.stop_reason === 'refusal') {
          refused = true;
          problem =
            (msg.stop_details as { explanation?: string } | null | undefined)?.explanation ??
            'the model declined';
          break;
        }
        if (msg.stop_reason === 'max_tokens') {
          problem = 'the answer was cut off at the token limit';
          continue;
        }
        const text = msg.content.find((b) => b.type === 'text');
        if (!text || text.type !== 'text') {
          problem = 'there was no text answer';
          continue;
        }
        let parsed: T;
        try {
          parsed = format.parse(text.text);
        } catch (err) {
          problem = `the JSON did not match the schema (${errorMessage(err).slice(0, 300)})`;
          continue;
        }
        const restored = c.redactor.restoreDeep(parsed);
        const semantic = c.check?.(restored) ?? null;
        if (semantic) {
          problem = semantic;
          continue;
        }
        result = restored;
      } catch (err) {
        lastError = err;
        break; // API errors are not retried here (the SDK already retried once)
      }
    }

    const latencyMs = this.d.now().getTime() - started.getTime();
    const status: AiCallStatus = result
      ? attempts > 1
        ? 'retried'
        : 'ok'
      : refused
        ? 'refused'
        : lastError
          ? 'error'
          : 'fallback';
    const error = result ? null : lastError ? describeError(lastError) : problem;
    const callId = await this.d.store.record({
      ...base,
      attempts,
      ...usage,
      latencyMs,
      costUsd: Math.round(cost * 100_000) / 100_000,
      status,
      stopReason,
      servedBy,
      error,
      requestId,
    });
    const after = await this.budget();
    const logFields = {
      purpose: c.purpose,
      model: c.model,
      incidentId: c.incidentId ?? undefined,
      status,
      attempts,
      latencyMs,
      costUsd: cost,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
    };
    if (result) {
      this.d.log.info(logFields, 'ai call ok');
      return {
        ok: true,
        data: result,
        status: status as 'ok' | 'retried',
        callId,
        model: servedBy ?? c.model,
        costUsd: cost,
        budget: after,
      };
    }
    this.d.log.warn({ ...logFields, error }, 'ai call fell back to the template');
    return {
      ok: false,
      status: status as Exclude<AiCallStatus, 'ok' | 'retried'>,
      transient: status === 'error' && isTransient(lastError),
      error: error ?? 'unknown',
      callId,
      budget: after,
    };
  }
}

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
