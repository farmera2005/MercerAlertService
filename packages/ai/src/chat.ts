/**
 * One "Ask the network" turn: a manual tool loop over the read-only tools, streamed so the
 * person sees progress. Every model request is budget-checked first and logged to ai_calls.
 * Tool inputs are validated (by the executor) before anything runs. Tool output is redacted
 * with the thread's placeholder map, and the turn is appended to the thread history only when
 * it completes, so the history stays a valid, append-only conversation.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  CHAT_TASK,
  CHAT_TOOL_DESCRIPTIONS,
  CHAT_TOOL_INPUTS,
  CHAT_TOOL_NAMES,
  chatUserText,
  describeToolCall,
  errorMessage,
  estimateCostUsd,
  extractCitations,
  Redactor,
  refsInToolOutput,
  type Citation,
} from '@mercer/core';
import { describeError, FALLBACK_BETA, isTransient, type AiRunner } from './runner';

type Msg = Anthropic.Beta.BetaMessageParam;

export interface ChatTurnInput {
  model: string;
  /** The cached prefix (role, environment, site profiles). */
  prefix: string;
  /** The thread's API history so far (as sent: redacted, thinking blocks included). */
  history: Msg[];
  redaction: Record<string, string>;
  seenRefs: string[];
  question: string;
  nowLocal: string;
  timeZone: string;
  /** Runs a read-only tool (validates its input itself). */
  executeTool: (name: string, input: unknown) => Promise<{ ok: boolean; output: string }>;
  /** Progress for the UI: a tool call is starting. */
  onStep?: (label: string) => void;
  /** Progress for the UI: answer text as it streams (placeholders already restored). */
  onText?: (delta: string) => void;
  maxSteps?: number;
  /** Wall-clock limit for the whole turn. */
  deadlineMs?: number;
}

export interface ChatTurnResult {
  status: 'ok' | 'error' | 'refused' | 'budget_blocked';
  /** The answer with placeholders restored (or an explanation for the person). */
  text: string;
  citations: Citation[];
  steps: string[];
  error: string | null;
  model: string;
  costUsd: number;
  transient: boolean;
  /** Append to the thread history (only meaningful when status is ok). */
  historyAppend: Msg[];
  redaction: Record<string, string>;
  seenRefs: string[];
}

/** JSON schemas for the tools, generated from the same Zod schemas the executor checks. */
export const CHAT_TOOLS: Anthropic.Beta.BetaTool[] = CHAT_TOOL_NAMES.map((name) => {
  const { $schema: _drop, ...schema } = z.toJSONSchema(CHAT_TOOL_INPUTS[name]) as Record<
    string,
    unknown
  >;
  void _drop;
  return {
    name,
    description: CHAT_TOOL_DESCRIPTIONS[name],
    input_schema: schema as Anthropic.Beta.BetaTool['input_schema'],
    // Inputs stream as generated; the executor validates them before running anything.
    eager_input_streaming: true,
  };
});

/** Words in tool output that look like serials but are context (hostnames, models, vendors). */
function contextWords(json: string): string[] {
  const out: string[] = [];
  for (const m of json.matchAll(/"(?:hostname|model|vendor|interface|entity)":"([^"]{1,120})"/g))
    out.push(m[1]!);
  return out;
}

/**
 * Forward streamed text with placeholders restored. A placeholder can be split across deltas
 * ("[IP-" … "3]"), so a trailing "[" fragment is held back until it is complete.
 */
function restoringForwarder(redactor: Redactor, emit?: (s: string) => void) {
  let pending = '';
  return {
    push(delta: string) {
      if (!emit) return;
      pending += delta;
      const open = pending.lastIndexOf('[');
      const hold = open >= 0 && !pending.slice(open).includes(']') && pending.length - open < 16;
      const ready = hold ? pending.slice(0, open) : pending;
      pending = hold ? pending.slice(open) : '';
      if (ready) emit(redactor.restore(ready));
    },
    flush() {
      if (emit && pending) emit(redactor.restore(pending));
      pending = '';
    },
  };
}

export async function runChatTurn(runner: AiRunner, input: ChatTurnInput): Promise<ChatTurnResult> {
  const { cfg, store, log, now } = runner.d;
  const started = now().getTime();
  const deadline = started + (input.deadlineMs ?? 180_000);
  const maxSteps = input.maxSteps ?? 8;
  const redactor = new Redactor(cfg.redact).importState(input.redaction);
  const stable = redactor.redact(input.prefix);
  const seen = new Set(input.seenRefs);
  const steps: string[] = [];
  const turn: Msg[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: redactor.redact(chatUserText(input.question, input.nowLocal, input.timeZone)),
        },
      ],
    },
  ];
  let cost = 0;
  let servedBy = input.model;
  const result = (
    r: Pick<ChatTurnResult, 'status' | 'text' | 'error'> & { transient?: boolean },
  ): ChatTurnResult => {
    const ok = r.status === 'ok';
    return {
      ...r,
      transient: r.transient ?? false,
      citations: ok ? extractCitations(r.text, seen) : [],
      steps,
      model: servedBy,
      costUsd: Math.round(cost * 100_000) / 100_000,
      historyAppend: ok ? turn : [],
      redaction: redactor.exportState(),
      seenRefs: [...seen],
    };
  };

  for (let step = 1; step <= maxSteps; step++) {
    const budget = await runner.budget();
    if (budget.level === 'exhausted') {
      await store.record({
        at: now(),
        purpose: 'chat',
        model: input.model,
        incidentId: null,
        attempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: 0,
        costUsd: 0,
        status: 'budget_blocked',
        stopReason: null,
        servedBy: null,
        error: `daily budget of US$${cfg.dailyBudgetUsd} reached`,
        redacted: redactor.enabled,
        requestId: null,
      });
      return result({
        status: 'budget_blocked',
        text: 'The daily AI budget is used up, so “Ask the network” is paused until midnight. The dashboard pages still have all the data.',
        error: 'daily AI budget reached',
        transient: true,
      });
    }
    const remaining = deadline - now().getTime();
    if (remaining <= 5_000)
      return result({
        status: 'error',
        text: 'That took too long to answer. Try a narrower question.',
        error: 'turn deadline reached',
      });

    const callStarted = now().getTime();
    const forward = restoringForwarder(redactor, input.onText);
    let msg: Anthropic.Beta.BetaMessage;
    let requestId: string | null;
    try {
      const stream = runner.client.beta.messages.stream(
        {
          model: input.model,
          max_tokens: 16_000,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort: 'medium' },
          // The conversation so far is cached too (top-level breakpoint on the last block).
          cache_control: { type: 'ephemeral' },
          system: [
            { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: CHAT_TASK },
          ],
          tools: CHAT_TOOLS,
          messages: [...input.history, ...turn],
        },
        { timeout: Math.min(cfg.timeoutMs, remaining) },
      );
      stream.on('text', (delta) => forward.push(delta));
      msg = await stream.finalMessage();
      requestId = stream.request_id ?? null;
      forward.flush();
    } catch (err) {
      const latencyMs = now().getTime() - callStarted;
      await store.record({
        at: now(),
        purpose: 'chat',
        model: input.model,
        incidentId: null,
        attempts: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs,
        costUsd: 0,
        status: 'error',
        stopReason: null,
        servedBy: null,
        error: describeError(err),
        redacted: redactor.enabled,
        requestId: null,
      });
      log.warn({ err: describeError(err), step }, 'chat request failed');
      const transient = isTransient(err) || !(err instanceof Anthropic.APIError);
      return result({
        status: 'error',
        text: transient
          ? 'Claude could not be reached just now. Please ask again in a minute.'
          : 'Claude rejected the request. An administrator can check Settings → AI.',
        error: describeError(err),
        transient,
      });
    }

    const u = msg.usage;
    const usage = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    };
    const stepCost = estimateCostUsd(msg.model, usage);
    cost += stepCost;
    if (msg.model !== input.model) servedBy = msg.model;
    const refused = msg.stop_reason === 'refusal';
    await store.record({
      at: now(),
      purpose: 'chat',
      model: input.model,
      incidentId: null,
      attempts: 1,
      ...usage,
      latencyMs: now().getTime() - callStarted,
      costUsd: Math.round(stepCost * 100_000) / 100_000,
      status: refused ? 'refused' : 'ok',
      stopReason: msg.stop_reason ?? null,
      servedBy: msg.model !== input.model ? msg.model : null,
      error: null,
      redacted: redactor.enabled,
      requestId,
    });

    if (refused)
      return result({
        status: 'refused',
        text: 'Claude declined to answer that question.',
        error:
          (msg.stop_details as { explanation?: string } | null | undefined)?.explanation ??
          'refused',
      });

    turn.push({
      role: 'assistant',
      content: msg.content as Anthropic.Beta.BetaContentBlockParam[],
    });
    const toolUses = msg.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
    );

    if (msg.stop_reason === 'tool_use' && toolUses.length) {
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const t of toolUses) {
        const toolInput = redactor.restoreDeep(t.input);
        const label = describeToolCall(t.name, toolInput);
        steps.push(label);
        input.onStep?.(label);
        let out: { ok: boolean; output: string };
        try {
          out = await input.executeTool(t.name, toolInput);
        } catch (err) {
          log.error({ tool: t.name, err: errorMessage(err) }, 'chat tool failed');
          out = { ok: false, output: JSON.stringify({ error: 'The tool failed; try again.' }) };
        }
        for (const r of refsInToolOutput(out.output)) seen.add(r);
        redactor.addKeep(contextWords(out.output));
        results.push({
          type: 'tool_result',
          tool_use_id: t.id,
          content: redactor.redact(out.output),
          ...(out.ok ? {} : { is_error: true }),
        });
      }
      turn.push({ role: 'user', content: results });
      continue;
    }

    const text = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (msg.stop_reason === 'max_tokens' || !text)
      return result({
        status: 'error',
        text: text
          ? `${redactor.restore(text)}\n\n(The answer was cut short.)`
          : 'Claude gave no answer. Try rephrasing the question.',
        error: msg.stop_reason === 'max_tokens' ? 'max_tokens' : 'empty answer',
      });
    return result({ status: 'ok', text: redactor.restore(text), error: null });
  }
  return result({
    status: 'error',
    text: 'That needed more lookups than allowed for one question. Try a narrower question.',
    error: `more than ${maxSteps} steps`,
  });
}
