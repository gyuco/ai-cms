import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  AnthropicEngine,
  mapStopReason,
  toAnthropicMessages,
  toAnthropicRequest,
  toAnthropicTools,
  type AnthropicClientLike,
} from './anthropic.ts';
import type { ChatEvent, ChatMessage, ChatRequest, ToolSpec } from './types.ts';

const DEV_MODEL = 'claude-opus-5-5';
const CONTENT_MODEL = 'claude-sonnet-5';

const tools: ToolSpec[] = [
  {
    name: 'read_page',
    description: 'Reads a page',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'list_children',
    description: 'Lists children',
    inputSchema: { type: 'object', properties: {} },
  },
];

const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };

const conversation: ChatMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Leggi la home' }] },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', provider: 'anthropic', data: thinking },
      { type: 'text', text: 'Leggo.' },
      { type: 'tool_call', id: 'toolu_1', name: 'read_page', input: { path: '/site' } },
      { type: 'reasoning', provider: 'openai-compatible', data: { ignored: true } },
      { type: 'text', text: '' },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'grazie' },
      { type: 'tool_result', toolCallId: 'toolu_1', content: '<h1>Home</h1>' },
      { type: 'tool_result', toolCallId: 'toolu_2', content: 'Accesso negato', isError: true },
    ],
  },
];

describe('anthropic translation', () => {
  it('translates messages, keeping thinking blocks and putting tool results first', () => {
    expect(toAnthropicMessages(conversation)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Leggi la home' }] },
      {
        role: 'assistant',
        content: [
          thinking,
          { type: 'text', text: 'Leggo.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_page', input: { path: '/site' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '<h1>Home</h1>' },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: 'Accesso negato',
            is_error: true,
          },
          { type: 'text', text: 'grazie' },
        ],
      },
    ]);
  });

  it('caches the tool list with a breakpoint on the last tool', () => {
    const out = toAnthropicTools(tools, true);
    expect(out[0]).toEqual({
      name: 'read_page',
      description: 'Reads a page',
      input_schema: tools[0]!.inputSchema,
      eager_input_streaming: true,
    });
    expect(out[1]).toMatchObject({ name: 'list_children', cache_control: { type: 'ephemeral' } });
  });

  it('builds a streaming request with cached system prompt and no prefill', () => {
    const req: ChatRequest = {
      model: DEV_MODEL,
      system: 'Sei l’agente sviluppatore.',
      messages: conversation,
      tools,
    };
    const params = toAnthropicRequest(req, { effort: 'high' });
    expect(params).toMatchObject({
      model: DEV_MODEL,
      max_tokens: 64_000,
      stream: true,
      system: [
        { type: 'text', text: 'Sei l’agente sviluppatore.', cache_control: { type: 'ephemeral' } },
      ],
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
    });
    expect(params).not.toHaveProperty('thinking');
    expect(params.messages.at(-1)?.role).toBe('user');

    const bare = toAnthropicRequest(
      { model: CONTENT_MODEL, system: '', messages: [], tools: [], maxOutputTokens: 1000 },
      {},
    );
    expect(bare).not.toHaveProperty('system');
    expect(bare).not.toHaveProperty('tools');
    expect(bare.max_tokens).toBe(1000);
  });

  it('maps stop reasons', () => {
    expect(mapStopReason('end_turn')).toBe('end_turn');
    expect(mapStopReason('stop_sequence')).toBe('end_turn');
    expect(mapStopReason('tool_use')).toBe('tool_use');
    expect(mapStopReason('max_tokens')).toBe('max_tokens');
    expect(mapStopReason('model_context_window_exceeded')).toBe('max_tokens');
    expect(mapStopReason('refusal')).toBe('refusal');
  });
});

// Recorded from a Messages API stream (ids shortened).
const toolUseStream = [
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: DEV_MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 1,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 30,
      },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Leggo ' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'le pagine.' } },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'toolu_a', name: 'read_page', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"pa' },
  },
  {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: 'th": "/site"}' },
  },
  { type: 'content_block_stop', index: 2 },
  {
    type: 'content_block_start',
    index: 3,
    content_block: { type: 'tool_use', id: 'toolu_b', name: 'list_children', input: {} },
  },
  { type: 'content_block_stop', index: 3 },
  {
    type: 'content_block_start',
    index: 4,
    content_block: { type: 'tool_use', id: 'toolu_c', name: 'read_page', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 4,
    delta: { type: 'input_json_delta', partial_json: '{"path": "/si' },
  },
  { type: 'content_block_stop', index: 4 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null, stop_details: null },
    usage: { output_tokens: 87 },
  },
  { type: 'message_stop' },
] as unknown as Anthropic.RawMessageStreamEvent[];

async function* replay<T>(events: T[], signal?: AbortSignal) {
  for (const event of events) {
    if (signal?.aborted) throw new Anthropic.APIUserAbortError();
    yield event;
    await Promise.resolve();
  }
}

function fakeClient(
  stream: (
    body: Anthropic.MessageCreateParamsStreaming,
    signal?: AbortSignal,
  ) => AsyncIterable<Anthropic.RawMessageStreamEvent>,
  models: AnthropicClientLike['models'] = {
    retrieve: async () => {
      throw new Error('offline');
    },
  },
) {
  const calls: Anthropic.MessageCreateParamsStreaming[] = [];
  const client: AnthropicClientLike = {
    messages: {
      create: async (body, options) => {
        calls.push(body);
        return stream(body, options?.signal);
      },
    },
    models,
  };
  return { client, calls };
}

async function collect(events: AsyncIterable<ChatEvent>) {
  const out: ChatEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const request: ChatRequest = {
  model: DEV_MODEL,
  system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
  tools,
};

describe('AnthropicEngine.stream', () => {
  it('normalizes a recorded tool-use stream in content order', async () => {
    const { client, calls } = fakeClient(() => replay(toolUseStream));
    const events = await collect(new AnthropicEngine({ client }).stream(request));
    expect(events).toEqual([
      {
        type: 'reasoning',
        provider: 'anthropic',
        data: { type: 'thinking', thinking: '', signature: 'sig' },
      },
      { type: 'text_delta', text: 'Leggo ' },
      { type: 'text_delta', text: 'le pagine.' },
      { type: 'tool_call', id: 'toolu_a', name: 'read_page', input: { path: '/site' } },
      { type: 'tool_call', id: 'toolu_b', name: 'list_children', input: {} },
      // Unparseable JSON is passed on raw, for the loop to reject.
      { type: 'tool_call', id: 'toolu_c', name: 'read_page', input: '{"path": "/si' },
      {
        type: 'usage',
        inputTokens: 2042,
        outputTokens: 87,
        cacheReadTokens: 2000,
        cacheWriteTokens: 30,
      },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    expect(calls[0]?.tools?.[0]).toHaveProperty('eager_input_streaming', true);
  });

  it('reports refusals with their explanation', async () => {
    const refusal = [
      toolUseStream[0]!,
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'refusal',
          stop_sequence: null,
          stop_details: { type: 'refusal', category: 'cyber', explanation: 'Non posso aiutare.' },
        },
        usage: { output_tokens: 3 },
      },
      { type: 'message_stop' },
    ] as unknown as Anthropic.RawMessageStreamEvent[];
    const { client } = fakeClient(() => replay(refusal));
    const events = await collect(new AnthropicEngine({ client }).stream(request));
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'refusal',
      detail: 'Non posso aiutare.',
    });
  });

  it('turns API errors into error events', async () => {
    const client: AnthropicClientLike = {
      messages: {
        create: async () => {
          throw new Anthropic.RateLimitError(429, undefined, 'rate limited', new Headers());
        },
      },
      models: { retrieve: async () => ({ capabilities: null, max_input_tokens: null }) },
    };
    const events = await collect(new AnthropicEngine({ client }).stream(request));
    expect(events).toEqual([
      {
        type: 'error',
        message: expect.stringContaining('rate limited'),
        status: 429,
        retryable: true,
      },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const { client } = fakeClient((_body, signal) =>
      (async function* () {
        for await (const e of replay(toolUseStream, signal)) {
          yield e;
          if (e.type === 'content_block_stop') controller.abort();
        }
      })(),
    );
    const events = await collect(
      new AnthropicEngine({ client }).stream({ ...request, signal: controller.signal }),
    );
    expect(events.slice(-2)).toEqual([
      { type: 'error', message: 'Richiesta interrotta', aborted: true },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('disables eager input streaming behind a custom baseURL', async () => {
    const { client, calls } = fakeClient(() => replay(toolUseStream));
    await collect(new AnthropicEngine({ client, baseURL: 'http://gateway' }).stream(request));
    expect(calls[0]?.tools?.[0]).not.toHaveProperty('eager_input_streaming');
  });
});

describe('AnthropicEngine.capabilities', () => {
  it('uses the Models API when available', async () => {
    const { client } = fakeClient(() => replay([]), {
      retrieve: async () => ({
        max_input_tokens: 1_000_000,
        capabilities: { image_input: { supported: true } } as Anthropic.ModelCapabilities,
      }),
    });
    await expect(new AnthropicEngine({ client }).capabilities(DEV_MODEL)).resolves.toEqual({
      tools: true,
      vision: true,
      streaming: true,
      contextWindow: 1_000_000,
    });
  });

  it('falls back to the capability table', async () => {
    const { client } = fakeClient(() => replay([]));
    const engine = new AnthropicEngine({
      client,
      capabilityTable: [{ model: CONTENT_MODEL, caps: { tools: true, vision: false } }],
    });
    await expect(engine.capabilities(CONTENT_MODEL)).resolves.toEqual({
      tools: true,
      vision: false,
      streaming: true,
    });
  });
});
