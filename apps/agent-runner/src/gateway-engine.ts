import type { ChatEngine, ChatEvent, ChatRequest, ModelCaps } from '@ai-cms/ai';
import type { FetchLike } from './cms-client.ts';

export interface GatewayChatEngineOptions {
  /** cms-api base URL, e.g. `http://cms-api:3100`. */
  baseUrl: string;
  /** Agent session token: it fixes the user, the role and therefore the model. */
  token: string;
  fetch?: FetchLike;
}

function isEvent(value: unknown): value is ChatEvent {
  return typeof value === 'object' && value !== null && 'type' in value;
}

/**
 * A ChatEngine that calls the AI gateway of cms-api (`POST /_cms/internal/ai/chat`), so the
 * runner never holds an API key (TECHNICAL §7.2). cms-api picks connection and model from the
 * role assignment: `req.model` is ignored and the ones actually used are recorded from the
 * response headers.
 */
export class GatewayChatEngine implements ChatEngine {
  // The real provider is chosen by cms-api; the agent loop does not use this field.
  readonly provider = 'openai-compatible' as const;
  /** Connection and model of the last call, from `x-ai-connection` and `x-ai-model`. */
  connection?: string;
  model?: string;
  readonly #options: GatewayChatEngineOptions;

  constructor(options: GatewayChatEngineOptions) {
    this.#options = options;
  }

  async capabilities(): Promise<ModelCaps> {
    // cms-api refuses tool roles on models without tool calling (FR-124).
    return { tools: true, vision: false, streaming: true };
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    const { baseUrl, token } = this.#options;
    const doFetch: FetchLike = this.#options.fetch ?? ((input, init) => fetch(input, init));
    let res: Response;
    try {
      res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/_cms/internal/ai/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          request: {
            system: req.system,
            messages: req.messages,
            tools: req.tools,
            ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
          },
        }),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      const aborted = req.signal?.aborted ?? false;
      yield {
        type: 'error',
        message: aborted
          ? 'Richiesta interrotta.'
          : `Gateway AI non raggiungibile: ${err instanceof Error ? err.message : String(err)}`,
        ...(aborted ? { aborted: true } : { retryable: true }),
      };
      yield { type: 'done', stopReason: 'error' };
      return;
    }

    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      yield {
        type: 'error',
        message: body?.error?.message ?? `Il gateway AI ha risposto ${res.status}.`,
        status: res.status,
        ...(res.status === 429 || res.status >= 500 ? { retryable: true } : {}),
      };
      yield { type: 'done', stopReason: 'error' };
      return;
    }
    this.connection = res.headers.get('x-ai-connection') ?? undefined;
    this.model = res.headers.get('x-ai-model') ?? undefined;

    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    const parse = function* (line: string): Generator<ChatEvent> {
      if (!line.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (!isEvent(value)) return;
      if (value.type === 'error' && typeof value.resetsAt === 'string') {
        value = { ...value, resetsAt: new Date(value.resetsAt) };
      }
      if ((value as ChatEvent).type === 'done') done = true;
      yield value as ChatEvent;
    };

    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          yield* parse(line);
        }
      }
      buffer += decoder.decode();
      yield* parse(buffer);
    } catch (err) {
      if (done) return;
      const aborted = req.signal?.aborted ?? false;
      yield {
        type: 'error',
        message: aborted
          ? 'Richiesta interrotta.'
          : `Connessione al gateway AI interrotta: ${err instanceof Error ? err.message : String(err)}`,
        ...(aborted ? { aborted: true } : { retryable: true }),
      };
      yield { type: 'done', stopReason: 'error' };
      return;
    }
    if (!done) {
      yield { type: 'error', message: 'Risposta del gateway AI incompleta.', retryable: true };
      yield { type: 'done', stopReason: 'error' };
    }
  }
}
