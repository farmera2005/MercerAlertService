import { describe, expect, it } from 'vitest';
import { budgetState, estimateCostUsd, priceFor } from './pricing';

describe('estimateCostUsd', () => {
  it('prices input, output and cache tokens', () => {
    // 2,000 fresh in, 3,000 cache read, 1,000 cache write, 500 out on Opus 5.5.
    const usd = estimateCostUsd('claude-opus-5-5', {
      inputTokens: 2000,
      cacheReadTokens: 3000,
      cacheWriteTokens: 1000,
      outputTokens: 500,
    });
    // 2000×4 + 1000×4×1.25 + 3000×0.2 + 500×20 = 8000+5000+600+10000 = 23,600 per M
    expect(usd).toBe(0.0236);
  });

  it('uses long-context rates for big Haiku prompts and the dearest price for unknown models', () => {
    const big = estimateCostUsd('claude-haiku-5-5', {
      inputTokens: 200_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
    expect(big).toBe(0.1);
    expect(priceFor('claude-unknown-9').known).toBe(false);
    expect(
      estimateCostUsd('claude-unknown-9', {
        inputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    ).toBeGreaterThanOrEqual(8);
  });
});

describe('budgetState', () => {
  it('warns at 80 % and stops at 100 %', () => {
    expect(budgetState(1, 5).level).toBe('ok');
    expect(budgetState(4, 5).level).toBe('warn');
    expect(budgetState(5, 5).level).toBe('exhausted');
    expect(budgetState(0, 0).level).toBe('exhausted');
  });
});
