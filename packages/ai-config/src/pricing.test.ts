import { describe, expect, it } from 'vitest';
import { estimateCost, lookupPrice } from './pricing.ts';

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

describe('pricing', () => {
  it('matches patterns, including provider-prefixed ids', () => {
    expect(lookupPrice('claude-opus-5-5')?.input).toBe(4);
    expect(lookupPrice('claude-opus-5')?.input).toBe(5);
    expect(lookupPrice('anthropic/claude-haiku-4-5')?.output).toBe(5);
    expect(lookupPrice('llama3.3')).toBeNull();
  });

  it('estimates cost per million tokens, with cache discounts', () => {
    expect(estimateCost('claude-opus-5', usage(1_000_000, 100_000))).toBeCloseTo(7.5);
    // 1M cached reads at 0.1× input.
    expect(estimateCost('claude-opus-5', usage(1_000_000, 0, 1_000_000))).toBeCloseTo(0.5);
    expect(estimateCost('unknown-model', usage(10, 10))).toBeNull();
  });

  it('lets custom rows override the defaults', () => {
    const custom = [{ model: 'claude-opus-5', input: 1, output: 1 }];
    expect(estimateCost('claude-opus-5', usage(1_000_000, 1_000_000), custom)).toBeCloseTo(2);
  });
});
