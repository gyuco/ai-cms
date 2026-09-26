/**
 * Provider-neutral chat types (TECHNICAL §7.2). Every adapter translates these to and from
 * its provider's wire format; the rest of the CMS only ever sees these shapes.
 */

export type Provider = 'anthropic' | 'openai' | 'google' | 'openai-compatible';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  /** Parsed arguments. A raw string means the model produced JSON that could not be parsed. */
  input: unknown;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/**
 * Opaque provider data that must be sent back unchanged on the next request to the same
 * provider (e.g. Anthropic thinking blocks, which carry a signature). Adapters for other
 * providers drop it.
 */
export interface ReasoningPart {
  type: 'reasoning';
  provider: Provider;
  data: unknown;
}

export type UserPart = TextPart | ToolResultPart;
export type AssistantPart = TextPart | ToolCallPart | ReasoningPart;

export type ChatMessage =
  { role: 'user'; content: UserPart[] } | { role: 'assistant'; content: AssistantPart[] };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the input object. */
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error';

export interface Usage {
  /** All input tokens processed, including those read from or written to the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Events of one model call. A stream always ends with exactly one `done` event; adapters
 * never throw while iterating: failures become an `error` event followed by
 * `done { stopReason: 'error' }`.
 */
export type ChatEvent =
  | { type: 'text_delta'; text: string }
  | ({ type: 'tool_call' } & Omit<ToolCallPart, 'type'>)
  | { type: 'reasoning'; provider: Provider; data: unknown }
  | ({ type: 'usage' } & Usage)
  | { type: 'done'; stopReason: StopReason; detail?: string }
  | {
      type: 'error';
      message: string;
      /** HTTP status from the provider, when there is one. */
      status?: number;
      /** Rate limits, overload, network errors: worth retrying or falling back (FR-122). */
      retryable?: boolean;
      aborted?: boolean;
      /** The subscription plan limit was reached (CLI engines): the connection is `rate_limited`. */
      rateLimited?: boolean;
      /** When the plan limit resets, if the provider said so. */
      resetsAt?: Date;
    };

export interface ModelCaps {
  tools: boolean;
  vision: boolean;
  contextWindow?: number;
  streaming: boolean;
}

export interface ChatEngine {
  readonly provider: Provider;
  capabilities(model: string): Promise<ModelCaps>;
  stream(req: ChatRequest): AsyncIterable<ChatEvent>;
}
