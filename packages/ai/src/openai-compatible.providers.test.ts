import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAICompatibleEngine } from './openai-compatible.ts';
import type { ChatEvent, ChatRequest, ToolSpec } from './types.ts';

const tools: ToolSpec[] = [
  {
    name: 'read_page',
    description: 'Reads a page',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

/** A chunk as it travels on the wire: the provider's own JSON, not an SDK type. */
type WireChunk = Record<string, unknown>;

interface RecordedRequest {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

interface Provider {
  /** Loopback origin, to be used as `baseURL`. */
  url: string;
  /** Every request the SDK put on the socket, in order. */
  requests: RecordedRequest[];
  close(): Promise<void>;
}

type Responder = (res: ServerResponse) => void;

/**
 * Loopback stand-in for a Chat Completions provider: one route per model id, so the same
 * server replays the recorded streams and the recorded error bodies of both providers. Only
 * the socket is real, which is what the SDK and the adapter are verified against.
 */
function startProvider(routes: Readonly<Record<string, Responder>>): Promise<Provider> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (part: Buffer) => (raw += part.toString('utf8')));
    req.on('end', () => {
      const body: Record<string, unknown> = raw === '' ? {} : JSON.parse(raw);
      requests.push({ path: req.url ?? '', authorization: req.headers.authorization, body });
      const route = routes[String(body['model'])];
      if (route) route(res);
      else
        json(res, 404, { error: { code: 404, message: `Unknown model ${String(body['model'])}` } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        requests,
        // The SDK keeps connections alive, so the server would never close on its own.
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Event stream terminated the way both providers terminate it. */
function sse(res: ServerResponse, chunks: readonly WireChunk[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

/** Event stream cut before the terminator, as it is when a provider fails mid-turn. */
function sseCut(res: ServerResponse, chunks: readonly WireChunk[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end();
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const request: ChatRequest = {
  model: 'da-impostare',
  system: 'Sei l’agente contenuti.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Leggi la home' }] }],
  tools,
};

const OPEN_ROUTER_MODEL = 'deepseek/deepseek-chat';

function routerChunk(delta: WireChunk, finish: string | null = null): WireChunk {
  return {
    id: 'gen-1756200000-2f9c',
    object: 'chat.completion.chunk',
    created: 1_756_200_000,
    model: OPEN_ROUTER_MODEL,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  };
}

/** Recorded OpenRouter turn: optional `reasoning` deltas, text, two tool calls in fragments. */
const routerStream: WireChunk[] = [
  routerChunk({ role: 'assistant', content: '' }),
  routerChunk({ reasoning: 'L’utente chiede ' }),
  routerChunk({ reasoning: 'la home.' }),
  routerChunk({ content: 'Controllo ' }),
  routerChunk({ content: 'due pagine.' }),
  routerChunk({
    tool_calls: [
      {
        index: 0,
        id: 'call_9a1',
        type: 'function',
        function: { name: 'read_page', arguments: '' },
      },
    ],
  }),
  routerChunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
  routerChunk({
    tool_calls: [
      {
        index: 1,
        id: 'call_9a2',
        type: 'function',
        function: { name: 'read_page', arguments: '{"path' },
      },
    ],
  }),
  routerChunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"/a"}' } }] }),
  routerChunk({ tool_calls: [{ index: 1, function: { arguments: '":"/b"}' } }] }),
  routerChunk({}, 'tool_calls'),
  {
    // Usage arrives in a last chunk with no choices, with the provider's own extras.
    id: 'gen-1756200000-2f9c',
    object: 'chat.completion.chunk',
    created: 1_756_200_000,
    model: OPEN_ROUTER_MODEL,
    choices: [],
    usage: {
      prompt_tokens: 812,
      completion_tokens: 96,
      total_tokens: 908,
      prompt_tokens_details: { cached_tokens: 768 },
      completion_tokens_details: { reasoning_tokens: 32 },
      cost: 0.000_042_3,
    },
  },
];

describe('OpenRouter wire shapes over a loopback socket', () => {
  let provider: Provider;
  let engine: OpenAICompatibleEngine;

  beforeAll(async () => {
    provider = await startProvider({
      [OPEN_ROUTER_MODEL]: (res) => sse(res, routerStream),
      'router/tronco': (res) => sse(res, [routerChunk({ content: 'Testo tronc' }, 'length')]),
      'router/filtro': (res) => sse(res, [routerChunk({}, 'content_filter')]),
      // Provider failure reported inside the stream, with the HTTP status in the error code.
      'router/errore-nello-stream': (res) =>
        sseCut(res, [
          routerChunk({ role: 'assistant', content: '' }),
          routerChunk({ content: 'Apro ' }),
          {
            error: {
              code: 429,
              message: 'Provider returned error',
              metadata: { provider_name: 'DeepSeek' },
            },
          },
        ]),
      // Same failure, but the whole body already answered: 200 and a plain JSON error.
      'router/errore-nel-corpo': (res) =>
        json(res, 200, {
          error: { code: 400, message: 'No endpoints found for your configuration' },
        }),
      'router/richiesta-non-valida': (res) =>
        json(res, 400, {
          error: { code: 400, message: 'No endpoints found that support streaming' },
        }),
      'router/non-disponibile': (res) =>
        json(res, 502, { error: { code: 502, message: 'Bad gateway' } }),
    });
    engine = new OpenAICompatibleEngine({ baseURL: `${provider.url}/v1`, apiKey: 'or-key' });
  });

  afterAll(() => provider.close());

  it('accumulates tool call fragments and reports the usage chunk', async () => {
    const events = await collect(engine.stream({ ...request, model: OPEN_ROUTER_MODEL }));
    // The `reasoning` deltas are not content: they produce no text_delta.
    expect(events).toEqual([
      { type: 'text_delta', text: 'Controllo ' },
      { type: 'text_delta', text: 'due pagine.' },
      { type: 'tool_call', id: 'call_9a1', name: 'read_page', input: { path: '/a' } },
      { type: 'tool_call', id: 'call_9a2', name: 'read_page', input: { path: '/b' } },
      { type: 'usage', inputTokens: 812, outputTokens: 96, cacheReadTokens: 768 },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('posts the streaming body to /v1/chat/completions', async () => {
    const before = provider.requests.length;
    await collect(engine.stream({ ...request, model: OPEN_ROUTER_MODEL, maxOutputTokens: 2_000 }));
    expect(provider.requests.at(before)).toEqual({
      path: '/v1/chat/completions',
      authorization: 'Bearer or-key',
      body: {
        model: OPEN_ROUTER_MODEL,
        messages: [
          { role: 'system', content: 'Sei l’agente contenuti.' },
          { role: 'user', content: 'Leggi la home' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_page',
              description: 'Reads a page',
              parameters: tools[0]!.inputSchema,
            },
          },
        ],
        max_tokens: 2_000,
        // The adapter has no non-streaming mode: every turn asks for an event stream.
        stream: true,
        stream_options: { include_usage: true },
      },
    });
  });

  it('maps length and content_filter to the CMS stop reasons', async () => {
    await expect(collect(engine.stream({ ...request, model: 'router/tronco' }))).resolves.toEqual([
      { type: 'text_delta', text: 'Testo tronc' },
      { type: 'done', stopReason: 'max_tokens' },
    ]);
    await expect(collect(engine.stream({ ...request, model: 'router/filtro' }))).resolves.toEqual([
      { type: 'done', stopReason: 'refusal' },
    ]);
  });

  it('reports a mid-stream error with the status carried by the error code', async () => {
    const events = await collect(
      engine.stream({ ...request, model: 'router/errore-nello-stream' }),
    );
    expect(events).toEqual([
      { type: 'text_delta', text: 'Apro ' },
      { type: 'error', message: 'Provider returned error', status: 429, retryable: true },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('closes the turn when the 200 body is an error instead of an event stream', async () => {
    const events = await collect(engine.stream({ ...request, model: 'router/errore-nel-corpo' }));
    expect(events).toEqual([
      { type: 'error', message: 'Risposta del modello interrotta prima della fine' },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('maps the HTTP status of 4xx and 5xx answers', async () => {
    const rejected = await collect(
      engine.stream({ ...request, model: 'router/richiesta-non-valida' }),
    );
    expect(rejected).toEqual([
      {
        type: 'error',
        message: expect.stringContaining('No endpoints found that support streaming'),
        status: 400,
        retryable: false,
      },
      { type: 'done', stopReason: 'error' },
    ]);
    const down = await collect(engine.stream({ ...request, model: 'router/non-disponibile' }));
    expect(down).toEqual([
      {
        type: 'error',
        message: expect.stringContaining('Bad gateway'),
        status: 502,
        retryable: true,
      },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('answers capabilities from the table for provider and local model ids', async () => {
    const engine = new OpenAICompatibleEngine({
      baseURL: `${provider.url}/v1`,
      capabilityTable: [{ model: 'qwen3:*', caps: { tools: true, contextWindow: 40_960 } }],
    });
    // Default row, matched on the last segment of OpenRouter's `provider/model` id.
    await expect(engine.capabilities(OPEN_ROUTER_MODEL)).resolves.toEqual({
      tools: true,
      vision: false,
      streaming: true,
      contextWindow: 128_000,
    });
    // Local tags are plain strings: only the custom row can answer for them.
    await expect(engine.capabilities('qwen3:8b')).resolves.toEqual({
      tools: true,
      vision: false,
      streaming: true,
      contextWindow: 40_960,
    });
    // Unknown local models are assumed unable to call tools (FR-124).
    await expect(engine.capabilities('mio:modello')).resolves.toEqual({
      tools: false,
      vision: false,
      streaming: true,
    });
  });
});

const OLLAMA_MODEL = 'qwen3:8b';

function ollamaChunk(delta: WireChunk, finish: string | null = null): WireChunk {
  return {
    id: 'chatcmpl-6f0d1f2a',
    object: 'chat.completion.chunk',
    created: 1_756_200_123,
    model: OLLAMA_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/**
 * Recorded Ollama turn on `/v1/chat/completions`: every tool call arrives whole, in a single
 * delta, with neither `index` nor `id`, and the endpoint never sends a usage chunk.
 */
const ollamaStream: WireChunk[] = [
  ollamaChunk({ role: 'assistant', content: '' }),
  ollamaChunk({ content: 'Apro ' }),
  ollamaChunk({ content: 'la home.' }),
  ollamaChunk({
    tool_calls: [
      { type: 'function', function: { name: 'read_page', arguments: '{"path":"/"}' } },
      { type: 'function', function: { name: 'read_page', arguments: '{"path":"/chi-siamo"}' } },
    ],
  }),
  ollamaChunk({}, 'stop'),
];

describe('Ollama wire shapes over a loopback socket', () => {
  let provider: Provider;

  beforeAll(async () => {
    provider = await startProvider({
      [OLLAMA_MODEL]: (res) => sse(res, ollamaStream),
      'qwen3:8b-scritto': (res) => sse(res, [ollamaChunk({ content: 'Risposta' }, 'stop')]),
      'qwen3:8b-troncato': (res) =>
        sse(res, [ollamaChunk({ content: 'Risposta tagliata' }, 'length')]),
      // Ollama reports failures with a plain string in `error`, not with an object.
      'qwen3:8b-errore': (res) =>
        json(res, 404, { error: 'model "qwen3:8b-errore" not found, try pulling it first' }),
    });
  });

  afterAll(() => provider.close());

  it('accumulates whole tool calls and works without a usage chunk', async () => {
    const engine = new OpenAICompatibleEngine({ baseURL: `${provider.url}/v1` });
    const events = await collect(engine.stream({ ...request, model: OLLAMA_MODEL }));
    expect(events).toEqual([
      { type: 'text_delta', text: 'Apro ' },
      { type: 'text_delta', text: 'la home.' },
      {
        type: 'tool_call',
        id: expect.stringMatching(/^call_0_/),
        name: 'read_page',
        input: { path: '/' },
      },
      {
        type: 'tool_call',
        id: expect.stringMatching(/^call_1_/),
        name: 'read_page',
        input: { path: '/chi-siamo' },
      },
      // No usage event: the endpoint does not send the chunk even when asked for it.
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('sends stream_options only when usage was asked for', async () => {
    const before = provider.requests.length;
    await collect(
      new OpenAICompatibleEngine({ baseURL: `${provider.url}/v1`, includeUsage: false }).stream({
        ...request,
        model: OLLAMA_MODEL,
      }),
    );
    const sent = provider.requests.at(before);
    expect(sent?.path).toBe('/v1/chat/completions');
    expect(sent?.body).not.toHaveProperty('stream_options');
    // Local servers need no key, but the SDK insists on sending one.
    expect(sent?.authorization).toBe('Bearer not-needed');
  });

  it('maps its own finish reasons', async () => {
    const engine = new OpenAICompatibleEngine({ baseURL: `${provider.url}/v1` });
    await expect(
      collect(engine.stream({ ...request, model: 'qwen3:8b-scritto' })),
    ).resolves.toEqual([
      { type: 'text_delta', text: 'Risposta' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    await expect(
      collect(engine.stream({ ...request, model: 'qwen3:8b-troncato' })),
    ).resolves.toEqual([
      { type: 'text_delta', text: 'Risposta tagliata' },
      { type: 'done', stopReason: 'max_tokens' },
    ]);
  });

  it('reports an unknown model as a provider error', async () => {
    const engine = new OpenAICompatibleEngine({ baseURL: `${provider.url}/v1` });
    const events = await collect(engine.stream({ ...request, model: 'qwen3:8b-errore' }));
    expect(events).toEqual([
      {
        type: 'error',
        message: expect.stringContaining('not found'),
        status: 404,
        retryable: false,
      },
      { type: 'done', stopReason: 'error' },
    ]);
  });
});
