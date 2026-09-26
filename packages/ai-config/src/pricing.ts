import type { Usage } from '@ai-cms/ai';

/**
 * Price of a model in USD per million tokens. `model` is an exact id or a `*` pattern; the
 * first matching row wins. Cache rates default to 0.1× (read) and 1.25× (write) the input rate.
 */
export interface PriceEntry {
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Example list prices, used only for the cost ESTIMATE shown in the usage dashboard (FR-129).
 * They are not authoritative and change over time: the administrator can override them with
 * custom rows. Models without a row get no cost estimate (null), local models cost 0.
 */
export const DEFAULT_PRICES: readonly PriceEntry[] = [
  { model: 'claude-fable-5*', input: 10, output: 50 },
  { model: 'claude-opus-5-5*', input: 4, output: 20 },
  { model: 'claude-opus-*', input: 5, output: 25 },
  { model: 'claude-sonnet-5*', input: 2, output: 10 },
  { model: 'claude-sonnet-*', input: 3, output: 15 },
  { model: 'claude-haiku-*', input: 1, output: 5 },
];

function toRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function lookupPrice(model: string, custom: readonly PriceEntry[] = []): PriceEntry | null {
  // OpenRouter-style ids (`anthropic/claude-…`) are matched on the last segment too.
  const candidates = [model, model.split('/').at(-1) ?? model];
  for (const entry of [...custom, ...DEFAULT_PRICES]) {
    const re = toRegExp(entry.model);
    if (candidates.some((m) => re.test(m))) return entry;
  }
  return null;
}

/** Estimated cost in USD, or null when the model has no price row. */
export function estimateCost(
  model: string,
  usage: Required<Usage>,
  custom: readonly PriceEntry[] = [],
): number | null {
  const price = lookupPrice(model, custom);
  if (!price) return null;
  // `inputTokens` includes the cached tokens (see Usage).
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const cost =
    uncached * price.input +
    usage.cacheReadTokens * (price.cacheRead ?? price.input * 0.1) +
    usage.cacheWriteTokens * (price.cacheWrite ?? price.input * 1.25) +
    usage.outputTokens * price.output;
  return cost / 1_000_000;
}
