/**
 * Cost estimates for the `ai_calls` log and the daily budget. List prices in US$ per million
 * tokens (Anthropic first-party API). Cache writes use the 5-minute TTL rate (1.25× input).
 * An unknown model is priced at the most expensive entry, so the budget errs on the safe side.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** Long-prompt pricing (Haiku 5.5 above 100K input tokens). */
  longContext?: { aboveTokens: number; input: number; output: number };
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    longContext: { aboveTokens: 100_000, input: 0.5, output: 2.5 },
  },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
};

const MOST_EXPENSIVE = Object.values(MODEL_PRICES).reduce((a, b) => (b.output > a.output ? b : a));

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function priceFor(model: string): { price: ModelPrice; known: boolean } {
  const price = MODEL_PRICES[model];
  return price ? { price, known: true } : { price: MOST_EXPENSIVE, known: false };
}

/** Estimated cost in US$ (rounded to 5 decimals, the `ai_calls.cost_usd` scale). */
export function estimateCostUsd(model: string, u: TokenUsage): number {
  const { price } = priceFor(model);
  const promptTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const long = price.longContext && promptTokens > price.longContext.aboveTokens;
  const input = long ? price.longContext!.input : price.input;
  const output = long ? price.longContext!.output : price.output;
  const cacheRead = long ? price.cacheRead * (input / price.input) : price.cacheRead;
  const usd =
    (u.inputTokens * input +
      u.cacheWriteTokens * input * 1.25 +
      u.cacheReadTokens * cacheRead +
      u.outputTokens * output) /
    1_000_000;
  return Math.round(usd * 100_000) / 100_000;
}

export type BudgetLevel = 'ok' | 'warn' | 'exhausted';

export interface BudgetState {
  spentUsd: number;
  budgetUsd: number;
  /** 0–1+ (spent ÷ budget); 0 when the budget is 0 (unlimited is not offered). */
  fraction: number;
  level: BudgetLevel;
}

/** Warning at 80 %; at 100 % AI calls stop until midnight in APP_TIMEZONE (decision E2). */
export function budgetState(spentUsd: number, budgetUsd: number): BudgetState {
  if (budgetUsd <= 0) return { spentUsd, budgetUsd, fraction: 1, level: 'exhausted' };
  const fraction = spentUsd / budgetUsd;
  return {
    spentUsd,
    budgetUsd,
    fraction,
    level: fraction >= 1 ? 'exhausted' : fraction >= 0.8 ? 'warn' : 'ok',
  };
}
