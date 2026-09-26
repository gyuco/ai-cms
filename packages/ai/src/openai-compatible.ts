import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
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
export interface OpenAIClientLike {
  chat: {
    completions: {
      create(
        body: ChatCompletionCreateParamsStreaming,
        options?: { signal?: AbortSignal },
      ): PromiseLike<AsyncIterable<ChatCompletionChunk>>;
    };
  };
}

export interface OpenAICompatibleEngineOptions {
  /** e.g. https://openrouter.ai/api/v1, http://ollama:11434/v1 */
  baseURL?: string;
  /** Local servers need none. */
  apiKey?: string;
  client?: OpenAIClientLike;
  /** Some servers only accept the newer `max_completion_tokens`. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** Asks for a final usage chunk; turn off for servers that reject `stream_options`. */
  includeUsage?: boolean;
  capabilityTable?: CapabilityEntry[];
}

export function toOpenAITools(tools: ToolSpec[]): ChatCompletionFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

export function toOpenAIMessages(
  system: string,
  messages: ChatMessage[],
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    if (message.role === 'user') {
      const texts: string[] = [];
      for (const part of message.content) {
        if (part.type === 'tool_result') {
          // No error flag in this API: say it in the content.
          out.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            content: part.isError ? `ERROR: ${part.content}` : part.content,
          });
        } else if (part.text) {
          texts.push(part.text);
        }
      }
      if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n\n') });
      continue;
    }
    const text = message.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    const toolCalls = message.content.flatMap((part) =>
      part.type === 'tool_call'
        ? [
            {
              id: part.id,
              type: 'function' as const,
              function: {
                name: part.name,
                arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
              },
            },
          ]
        : [],
    );
    if (!text && toolCalls.length === 0) continue;
    out.push({
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return out;
}

export function toOpenAIRequest(
  req: ChatRequest,
  options: Pick<OpenAICompatibleEngineOptions, 'maxTokensParam' | 'includeUsage'> = {},
): ChatCompletionCreateParamsStreaming {
  return {
    model: req.model,
    messages: toOpenAIMessages(req.system, req.messages),
    ...(req.tools.length > 0 ? { tools: toOpenAITools(req.tools) } : {}),
    ...(req.maxOutputTokens !== undefined
      ? { [options.maxTokensParam ?? 'max_tokens']: req.maxOutputTokens }
      : {}),
    stream: true,
    ...((options.includeUsage ?? true) ? { stream_options: { include_usage: true } } : {}),
  };
}

export function mapFinishReason(
  reason: ChatCompletionChunk.Choice['finish_reason'],
  hasToolCalls: boolean,
): StopReason {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      // Several local servers report `stop` even when the turn ends with tool calls.
      return hasToolCalls ? 'tool_use' : 'end_turn';
  }
}

function errorEvent(err: unknown, signal?: AbortSignal): ChatEvent {
  if (err instanceof OpenAI.APIUserAbortError || signal?.aborted) {
    return { type: 'error', message: 'Richiesta interrotta', aborted: true };
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return { type: 'error', message: err.message, retryable: true };
  }
  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const retryable =
      status !== undefined && (status === 408 || status === 409 || status === 429 || status >= 500);
    return { type: 'error', message: err.message, ...(status ? { status } : {}), retryable };
  }
  return { type: 'error', message: err instanceof Error ? err.message : String(err) };
}

function parseArguments(json: string): unknown {
  if (json.trim() === '') return {};
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Normalizes Chat Completions chunks. Tool calls arrive in fragments keyed by `index`: the
 * first fragment usually carries id and name, later ones only pieces of `arguments`.
 */
export async function* normalizeOpenAIStream(
  chunks: AsyncIterable<ChatCompletionChunk>,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const calls = new Map<number, PendingToolCall>();
  let finish: ChatCompletionChunk.Choice['finish_reason'] = null;
  let refusal = '';
  let usage: ChatCompletionChunk['usage'] = null;

  try {
    for await (const chunk of chunks) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) yield { type: 'text_delta', text: delta.content };
      if (delta?.refusal) refusal += delta.refusal;
      for (const [position, fragment] of (delta?.tool_calls ?? []).entries()) {
        const index = fragment.index ?? position;
        let call = calls.get(index);
        if (!call) {
          call = { id: '', name: '', args: '' };
          calls.set(index, call);
        }
        if (fragment.id && !call.id) call.id = fragment.id;
        if (fragment.function?.name && !call.name) call.name = fragment.function.name;
        if (fragment.function?.arguments) call.args += fragment.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  } catch (err) {
    yield errorEvent(err, signal);
    yield { type: 'done', stopReason: 'error' };
    return;
  }

  if (finish === null) {
    yield signal?.aborted
      ? errorEvent(undefined, signal)
      : { type: 'error', message: 'Risposta del modello interrotta prima della fine' };
    yield { type: 'done', stopReason: 'error' };
    return;
  }

  const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  for (const [i, call] of ordered.entries()) {
    yield {
      type: 'tool_call',
      // Some local servers omit ids; the loop needs one to pair results with calls.
      id: call.id || `call_${i}_${Date.now().toString(36)}`,
      name: call.name,
      input: parseArguments(call.args),
    };
  }
  if (usage) {
    const cached = usage.prompt_tokens_details?.cached_tokens;
    yield {
      type: 'usage',
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      ...(cached ? { cacheReadTokens: cached } : {}),
    };
  }
  const stopReason = refusal ? 'refusal' : mapFinishReason(finish, ordered.length > 0);
  yield refusal ? { type: 'done', stopReason, detail: refusal } : { type: 'done', stopReason };
}

export class OpenAICompatibleEngine implements ChatEngine {
  readonly provider = 'openai-compatible' as const;
  readonly #client: OpenAIClientLike;
  readonly #options: OpenAICompatibleEngineOptions;

  constructor(options: OpenAICompatibleEngineOptions = {}) {
    this.#options = options;
    this.#client =
      options.client ??
      new OpenAI({
        // The SDK insists on a key; local servers ignore it.
        apiKey: options.apiKey ?? 'not-needed',
        ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      });
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
    let chunks: AsyncIterable<ChatCompletionChunk>;
    try {
      chunks = await this.#client.chat.completions.create(
        toOpenAIRequest(req, this.#options),
        req.signal ? { signal: req.signal } : undefined,
      );
    } catch (err) {
      yield errorEvent(err, req.signal);
      yield { type: 'done', stopReason: 'error' };
      return;
    }
    yield* normalizeOpenAIStream(chunks, req.signal);
  }

  /** Chat Completions servers do not report capabilities: the table decides. */
  async capabilities(model: string): Promise<ModelCaps> {
    return lookupCapabilities(model, this.#options.capabilityTable);
  }
}
