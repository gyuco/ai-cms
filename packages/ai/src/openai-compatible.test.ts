import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';
import {
  OpenAICompatibleEngine,
  mapFinishReason,
  toOpenAIMessages,
  toOpenAIRequest,
  type OpenAIClientLike,
} from './openai-compatible.ts';
import type { ChatEvent, ChatMessage, ChatRequest, ToolSpec } from './types.ts';

const tools: ToolSpec[] = [
  {
    name: 'read_page',
    description: 'Reads a page',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

describe('openai-compatible translation', () => {
  it('translates messages, tool calls and tool results', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Leggi la home' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', provider: 'anthropic', data: { type: 'thinking' } },
          { type: 'text', text: 'Leggo.' },
          { type: 'tool_call', id: 'call_1', name: 'read_page', input: { path: '/site' } },
          { type: 'tool_call', id: 'call_2', name: 'read_page', input: 'not json' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'call_1', content: '<h1>Home</h1>' },
          { type: 'tool_result', toolCallId: 'call_2', content: 'Input non valido', isError: true },
          { type: 'text', text: 'e poi?' },
        ],
      },
    ];
    expect(toOpenAIMessages('Sei l’agente contenuti.', messages)).toEqual([
      { role: 'system', content: 'Sei l’agente contenuti.' },
      { role: 'user', content: 'Leggi la home' },
      {
        role: 'assistant',
        content: 'Leggo.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_page', arguments: '{"path":"/site"}' },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'read_page', arguments: 'not json' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '<h1>Home</h1>' },
      { role: 'tool', tool_call_id: 'call_2', content: 'ERROR: Input non valido' },
      { role: 'user', content: 'e poi?' },
    ]);
  });

  it('builds a streaming request', () => {
    const req: ChatRequest = {
      model: 'qwen3:8b',
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
      tools,
      maxOutputTokens: 500,
    };
    expect(toOpenAIRequest(req)).toEqual({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'ciao' }],
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
      max_tokens: 500,
      stream: true,
      stream_options: { include_usage: true },
    });
    const alt = toOpenAIRequest(
      { ...req, tools: [] },
      { maxTokensParam: 'max_completion_tokens', includeUsage: false },
    );
    expect(alt).toMatchObject({ max_completion_tokens: 500 });
    expect(alt).not.toHaveProperty('tools');
    expect(alt).not.toHaveProperty('stream_options');
  });

  it('maps finish reasons', () => {
    expect(mapFinishReason('stop', false)).toBe('end_turn');
    expect(mapFinishReason('stop', true)).toBe('tool_use');
    expect(mapFinishReason('tool_calls', true)).toBe('tool_use');
    expect(mapFinishReason('length', false)).toBe('max_tokens');
    expect(mapFinishReason('content_filter', false)).toBe('refusal');
  });
});

function chunk(
  delta: ChatCompletionChunk.Choice['delta'],
  finish: ChatCompletionChunk.Choice['finish_reason'] = null,
): ChatCompletionChunk {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

// Recorded shape of an OpenAI-style stream with two parallel tool calls.
const toolStream: ChatCompletionChunk[] = [
  chunk({ role: 'assistant', content: '' }),
  chunk({ content: 'Controllo ' }),
  chunk({ content: 'due pagine.' }),
  chunk({
    tool_calls: [
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'read_page', arguments: '' },
      },
    ],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
  chunk({
    tool_calls: [
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'read_page', arguments: '{"path":' },
      },
    ],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"/a"}' } }] }),
  chunk({ tool_calls: [{ index: 1, function: { arguments: '"/b"}' } }] }),
  chunk({}, 'tool_calls'),
  {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 100 },
    },
  },
];

async function* replay<T>(items: T[], signal?: AbortSignal) {
  for (const item of items) {
    if (signal?.aborted) throw new OpenAI.APIUserAbortError();
    yield item;
    await Promise.resolve();
  }
}

function fakeClient(stream: (signal?: AbortSignal) => AsyncIterable<ChatCompletionChunk>): {
  client: OpenAIClientLike;
  calls: ChatCompletionCreateParamsStreaming[];
} {
  const calls: ChatCompletionCreateParamsStreaming[] = [];
  return {
    calls,
    client: {
      chat: {
        completions: {
          create: async (body, options) => {
            calls.push(body);
            return stream(options?.signal);
          },
        },
      },
    },
  };
}

async function collect(events: AsyncIterable<ChatEvent>) {
  const out: ChatEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const request: ChatRequest = {
  model: 'deepseek-chat',
  system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
  tools,
};

describe('OpenAICompatibleEngine.stream', () => {
  it('accumulates tool call fragments across chunks', async () => {
    const { client, calls } = fakeClient(() => replay(toolStream));
    const events = await collect(new OpenAICompatibleEngine({ client }).stream(request));
    expect(events).toEqual([
      { type: 'text_delta', text: 'Controllo ' },
      { type: 'text_delta', text: 'due pagine.' },
      { type: 'tool_call', id: 'call_a', name: 'read_page', input: { path: '/a' } },
      { type: 'tool_call', id: 'call_b', name: 'read_page', input: { path: '/b' } },
      { type: 'usage', inputTokens: 120, outputTokens: 30, cacheReadTokens: 100 },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    expect(calls[0]?.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('handles servers that send whole tool calls without ids and finish with stop', async () => {
    const { client } = fakeClient(() =>
      replay([
        chunk({
          tool_calls: [
            { index: 0, function: { name: 'read_page', arguments: '{"path":"/x"}' } },
            { index: 1, function: { name: 'read_page', arguments: '{"path"' } },
          ],
        }),
        chunk({}, 'stop'),
      ]),
    );
    const events = await collect(new OpenAICompatibleEngine({ client }).stream(request));
    expect(events).toEqual([
      {
        type: 'tool_call',
        id: expect.stringMatching(/^call_0_/),
        name: 'read_page',
        input: { path: '/x' },
      },
      {
        type: 'tool_call',
        id: expect.stringMatching(/^call_1_/),
        name: 'read_page',
        input: '{"path"',
      },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('reports refusals and truncation', async () => {
    const refused = fakeClient(() => replay([chunk({ refusal: 'Non posso.' }), chunk({}, 'stop')]));
    expect((await collect(new OpenAICompatibleEngine(refused).stream(request))).at(-1)).toEqual({
      type: 'done',
      stopReason: 'refusal',
      detail: 'Non posso.',
    });
    const truncated = fakeClient(() => replay([chunk({ content: 'Lung' }), chunk({}, 'length')]));
    expect((await collect(new OpenAICompatibleEngine(truncated).stream(request))).at(-1)).toEqual({
      type: 'done',
      stopReason: 'max_tokens',
    });
  });

  it('turns API errors into error events', async () => {
    const client: OpenAIClientLike = {
      chat: {
        completions: {
          create: async () => {
            throw new OpenAI.InternalServerError(503, undefined, 'unavailable', new Headers());
          },
        },
      },
    };
    const events = await collect(new OpenAICompatibleEngine({ client }).stream(request));
    expect(events).toEqual([
      {
        type: 'error',
        message: expect.stringContaining('unavailable'),
        status: 503,
        retryable: true,
      },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const { client } = fakeClient((signal) =>
      (async function* () {
        for await (const c of replay(toolStream, signal)) {
          yield c;
          controller.abort();
        }
      })(),
    );
    const events = await collect(
      new OpenAICompatibleEngine({ client }).stream({ ...request, signal: controller.signal }),
    );
    expect(events.slice(-2)).toEqual([
      { type: 'error', message: 'Richiesta interrotta', aborted: true },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('answers capabilities from the table', async () => {
    const engine = new OpenAICompatibleEngine({
      client: fakeClient(() => replay([])).client,
      capabilityTable: [{ model: 'my-local-model', caps: { tools: true } }],
    });
    await expect(engine.capabilities('my-local-model')).resolves.toMatchObject({ tools: true });
    await expect(engine.capabilities('deepseek-chat')).resolves.toMatchObject({ tools: true });
    await expect(engine.capabilities('unknown')).resolves.toMatchObject({ tools: false });
  });
});
