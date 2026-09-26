import type { ModelCaps } from './types.ts';

/**
 * One row of the capability table, used when a provider does not report model capabilities.
 * `model` is an exact id or a pattern with `*` wildcards; the first matching row wins.
 */
export interface CapabilityEntry {
  model: string;
  caps: Partial<ModelCaps>;
}

/** Unknown models are assumed unable to call tools, so FR-124 errs on the safe side. */
export const UNKNOWN_MODEL_CAPS: ModelCaps = { tools: false, vision: false, streaming: true };

export const DEFAULT_CAPABILITIES: readonly CapabilityEntry[] = [
  { model: 'claude-haiku-4-5*', caps: { tools: true, vision: true, contextWindow: 200_000 } },
  { model: 'claude-3*', caps: { tools: true, vision: true, contextWindow: 200_000 } },
  { model: 'claude-*', caps: { tools: true, vision: true, contextWindow: 1_000_000 } },
  { model: 'gpt-5*', caps: { tools: true, vision: true, contextWindow: 400_000 } },
  { model: 'gpt-4.1*', caps: { tools: true, vision: true, contextWindow: 1_000_000 } },
  { model: 'gpt-4o*', caps: { tools: true, vision: true, contextWindow: 128_000 } },
  { model: 'mistral-large*', caps: { tools: true, vision: false, contextWindow: 128_000 } },
  { model: 'mistral-medium*', caps: { tools: true, vision: true, contextWindow: 128_000 } },
  { model: 'deepseek-chat', caps: { tools: true, vision: false, contextWindow: 128_000 } },
  { model: 'qwen2.5*', caps: { tools: true, vision: false } },
  { model: 'qwen3*', caps: { tools: true, vision: false } },
  { model: 'llama3.1*', caps: { tools: true, vision: false } },
  { model: 'llama3.2*', caps: { tools: true, vision: false } },
  { model: 'llama3.3*', caps: { tools: true, vision: false } },
];

function toRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Resolves capabilities from the table. Custom rows (e.g. from `/system/ai`) come before the
 * defaults, so they can override them.
 */
export function lookupCapabilities(
  model: string,
  custom: readonly CapabilityEntry[] = [],
): ModelCaps {
  // Provider prefixes such as OpenRouter's `anthropic/claude-…` are matched on the last segment too.
  const candidates = [model, model.split('/').at(-1) ?? model];
  for (const entry of [...custom, ...DEFAULT_CAPABILITIES]) {
    const re = toRegExp(entry.model);
    if (candidates.some((m) => re.test(m))) return { ...UNKNOWN_MODEL_CAPS, ...entry.caps };
  }
  return { ...UNKNOWN_MODEL_CAPS };
}
