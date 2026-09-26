import Anthropic from '@anthropic-ai/sdk';
import { lookupCapabilities, type CapabilityEntry } from './capabilities.ts';
import type {
  ChatEngine,
  ChatEvent,
  ChatMessage,
  ChatRequest,
  ModelCaps,
  StopReason,
  ToolSpec,
} from './types.ts';

/** The part of the SDK client the adapter uses; tests inject a fake. */
export interface AnthropicClientLike {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): PromiseLike<AsyncIterable<Anthropic.RawMessageStreamEvent>>;
  };
  models: {
    retrieve(
      model: string,
    ): PromiseLike<Pick<Anthropic.ModelInfo, 'capabilities' | 'max_input_tokens'>>;
  };
}

export interface AnthropicEngineOptions {
  apiKey?: string;
  /** e.g. the CMS AI gateway; defaults to the public API. */
  baseURL?: string;
  client?: AnthropicClientLike;
  /** Used when `maxOutputTokens` is not set on the request. */
  defaultMaxOutputTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Streams large tool inputs as they are generated. Off by default when `baseURL` points
   * elsewhere, since proxies may reject the field. The agent loop validates every input.
   */
  eagerInputStreaming?: boolean;
  capabilityTable?: CapabilityEntry[];
}

const EPHEMERAL = { type: 'ephemeral' } as const;

export function toAnthropicTools(tools: ToolSpec[], eagerInputStreaming = false): Anthropic.Tool[] {
  return tools.map((tool, i) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    ...(eagerInputStreaming ? { eager_input_streaming: true } : {}),
    // Tools render first: one breakpoint on the last tool caches the whole tool list.
    ...(i === tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }));
}

export function toAnthropicSystem(system: string): Anthropic.TextBlockParam[] | undefined {
  if (!system) return undefined;
  return [{ type: 'text', text: system, cache_control: EPHEMERAL }];
}

function isThinkingParam(
  data: unknown,
): data is Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam {
  const type = (data as { type?: unknown } | null)?.type;
  return type === 'thinking' || type === 'redacted_thinking';
}

export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    if (message.role === 'user') {
      const results: Anthropic.ToolResultBlockParam[] = [];
      const texts: Anthropic.TextBlockParam[] = [];
      for (const part of message.content) {
        if (part.type === 'tool_result') {
          results.push({
            type: 'tool_result',
            tool_use_id: part.toolCallId,
            content: part.content,
            ...(part.isError ? { is_error: true } : {}),
          });
        } else if (part.text) {
          texts.push({ type: 'text', text: part.text });
        }
      }
      // The API wants tool results before any text in the same user turn.
      return { role: 'user', content: [...results, ...texts] };
    }
    const content: Anthropic.ContentBlockParam[] = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text) content.push({ type: 'text', text: part.text });
      } else if (part.type === 'tool_call') {
        content.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input });
      } else if (part.provider === 'anthropic' && isThinkingParam(part.data)) {
        // Thinking blocks go back unchanged, in their original position.
        content.push(part.data);
      }
    }
    return { role: 'assistant', content };
  });
}

export function mapStopReason(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case null:
      return 'error';
    // end_turn, stop_sequence; pause_turn only happens with server tools, which we do not use.
    default:
      return 'end_turn';
  }
}

export function toAnthropicRequest(
  req: ChatRequest,
  options: Pick<
    AnthropicEngineOptions,
    'defaultMaxOutputTokens' | 'effort' | 'eagerInputStreaming'
  >,
): Anthropic.MessageCreateParamsStreaming {
  const system = toAnthropicSystem(req.system);
  return {
    model: req.model,
    max_tokens: req.maxOutputTokens ?? options.defaultMaxOutputTokens ?? 64_000,
    ...(system ? { system } : {}),
    messages: toAnthropicMessages(req.messages),
    ...(req.tools.length > 0
      ? { tools: toAnthropicTools(req.tools, options.eagerInputStreaming) }
      : {}),
    ...(options.effort ? { output_config: { effort: options.effort } } : {}),
    // Automatic caching of the growing conversation, on top of the system and tool breakpoints.
    cache_control: EPHEMERAL,
    stream: true,
  };
}

const RETRYABLE_ERROR_TYPES = new Set(['overloaded_error', 'api_error', 'rate_limit_error']);

function errorEvent(err: unknown, signal?: AbortSignal): ChatEvent {
  if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) {
    return { type: 'error', message: 'Richiesta interrotta', aborted: true };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { type: 'error', message: err.message, retryable: true };
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    // Errors sent inside the SSE stream have no status, only the error type.
    const errorType = (err.error as { error?: { type?: string } } | undefined)?.error?.type;
    const retryable =
      status !== undefined
        ? status === 408 || status === 409 || status === 429 || status >= 500
        : errorType !== undefined && RETRYABLE_ERROR_TYPES.has(errorType);
    return { type: 'error', message: err.message, ...(status ? { status } : {}), retryable };
  }
  return { type: 'error', message: err instanceof Error ? err.message : String(err) };
}

function parseToolInput(json: string): unknown {
  if (json === '') return {};
  try {
    return JSON.parse(json);
  } catch {
    // Handed on as a string: schema validation in the agent loop turns it into an error result.
    return json;
  }
}

type OpenBlock =
  | { kind: 'text' }
  | { kind: 'tool'; id: string; name: string; json: string }
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'redacted'; data: string }
  | { kind: 'other' };

/**
 * Normalizes raw Messages API stream events. We accumulate the raw events ourselves (rather
 * than using the SDK's MessageStream) so that events come out in content-block order and an
 * unparseable tool input still yields a tool_call the loop can answer with an error.
 */
export async function* normalizeAnthropicStream(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const blocks = new Map<number, OpenBlock>();
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason: Anthropic.StopReason | null = null;
  let refusal: string | undefined;
  let finished = false;

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'message_start': {
          const u = event.message.usage;
          usage = {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
          };
          break;
        }
        case 'content_block_start': {
          const block = event.content_block;
          if (block.type === 'text') {
            blocks.set(event.index, { kind: 'text' });
            if (block.text) yield { type: 'text_delta', text: block.text };
          } else if (block.type === 'tool_use') {
            blocks.set(event.index, { kind: 'tool', id: block.id, name: block.name, json: '' });
          } else if (block.type === 'thinking') {
            blocks.set(event.index, {
              kind: 'thinking',
              thinking: block.thinking,
              signature: block.signature,
            });
          } else if (block.type === 'redacted_thinking') {
            blocks.set(event.index, { kind: 'redacted', data: block.data });
          } else {
            blocks.set(event.index, { kind: 'other' });
          }
          break;
        }
        case 'content_block_delta': {
          const block = blocks.get(event.index);
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            yield { type: 'text_delta', text: delta.text };
          } else if (delta.type === 'input_json_delta' && block?.kind === 'tool') {
            block.json += delta.partial_json;
          } else if (delta.type === 'thinking_delta' && block?.kind === 'thinking') {
            block.thinking += delta.thinking;
          } else if (delta.type === 'signature_delta' && block?.kind === 'thinking') {
            block.signature = delta.signature;
          }
          break;
        }
        case 'content_block_stop': {
          const block = blocks.get(event.index);
          blocks.delete(event.index);
          if (block?.kind === 'tool') {
            yield {
              type: 'tool_call',
              id: block.id,
              name: block.name,
              input: parseToolInput(block.json),
            };
          } else if (block?.kind === 'thinking') {
            yield {
              type: 'reasoning',
              provider: 'anthropic',
              data: { type: 'thinking', thinking: block.thinking, signature: block.signature },
            };
          } else if (block?.kind === 'redacted') {
            yield {
              type: 'reasoning',
              provider: 'anthropic',
              data: { type: 'redacted_thinking', data: block.data },
            };
          }
          break;
        }
        case 'message_delta': {
          stopReason = event.delta.stop_reason;
          const details = event.delta.stop_details;
          if (details) refusal = details.explanation ?? details.category ?? undefined;
          const u = event.usage;
          usage.output = u.output_tokens;
          if (u.input_tokens != null) usage.input = u.input_tokens;
          if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens;
          if (u.cache_creation_input_tokens != null)
            usage.cacheWrite = u.cache_creation_input_tokens;
          break;
        }
        case 'message_stop':
          finished = true;
          break;
      }
    }
  } catch (err) {
    yield errorEvent(err, signal);
    yield { type: 'done', stopReason: 'error' };
    return;
  }

  yield {
    type: 'usage',
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
  if (!finished) {
    yield signal?.aborted
      ? errorEvent(undefined, signal)
      : { type: 'error', message: 'Risposta del modello interrotta prima della fine' };
    yield { type: 'done', stopReason: 'error' };
    return;
  }
  const mapped = mapStopReason(stopReason);
  yield mapped === 'refusal' && refusal
    ? { type: 'done', stopReason: mapped, detail: refusal }
    : { type: 'done', stopReason: mapped };
}

export class AnthropicEngine implements ChatEngine {
  readonly provider = 'anthropic' as const;
  readonly #client: AnthropicClientLike;
  readonly #options: AnthropicEngineOptions;
  readonly #caps = new Map<string, Promise<ModelCaps>>();

  constructor(options: AnthropicEngineOptions = {}) {
    this.#options = {
      ...options,
      eagerInputStreaming: options.eagerInputStreaming ?? options.baseURL === undefined,
    };
    this.#client =
      options.client ??
      new Anthropic({
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      });
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
    let events: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      events = await this.#client.messages.create(
        toAnthropicRequest(req, this.#options),
        req.signal ? { signal: req.signal } : undefined,
      );
    } catch (err) {
      yield errorEvent(err, req.signal);
      yield { type: 'done', stopReason: 'error' };
      return;
    }
    yield* normalizeAnthropicStream(events, req.signal);
  }

  capabilities(model: string): Promise<ModelCaps> {
    let caps = this.#caps.get(model);
    if (!caps) {
      caps = this.#fetchCapabilities(model);
      this.#caps.set(model, caps);
    }
    return caps;
  }

  async #fetchCapabilities(model: string): Promise<ModelCaps> {
    const fallback = lookupCapabilities(model, this.#options.capabilityTable);
    try {
      const info = await this.#client.models.retrieve(model);
      return {
        tools: true,
        vision: info.capabilities?.image_input.supported ?? fallback.vision,
        streaming: true,
        ...(info.max_input_tokens
          ? { contextWindow: info.max_input_tokens }
          : fallback.contextWindow
            ? { contextWindow: fallback.contextWindow }
            : {}),
      };
    } catch {
      this.#caps.delete(model);
      return fallback;
    }
  }
}
