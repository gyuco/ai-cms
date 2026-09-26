import type { ChatEvent, ChatRequest } from '@ai-cms/ai';
import { describe, expect, it } from 'vitest';
import type { FetchLike } from './cms-client.ts';
import { GatewayChatEngine } from './gateway-engine.ts';

const request: ChatRequest = {
  model: 'ignored',
  system: 'Sei un agente.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Ciao' }] }],
  tools: [{ name: 'read_file', description: 'Legge', inputSchema: { type: 'object' } }],
  maxOutputTokens: 1000,
};

/** A streamed NDJSON body split at awkward places, as the network may deliver it. */
function ndjson(events: unknown[], chunkSize = 7): ReadableStream<Uint8Array> {
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

async function collect(engine: GatewayChatEngine): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of engine.stream(request)) out.push(event);
  return out;
}

describe('GatewayChatEngine', () => {
  it('posts the request with the token and yields the NDJSON events', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const events: ChatEvent[] = [
      { type: 'text_delta', text: 'Leggo è il file…' },
      { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'a' } },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', stopReason: 'tool_use' },
    ];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, init: init! });
      return new Response(ndjson(events), {
        headers: { 'x-ai-connection': 'anthropic-key', 'x-ai-model': 'claude-opus-5-5' },
      });
    };
    const engine = new GatewayChatEngine({ baseUrl: 'http://cms-api:3100/', token: 'tok', fetch });
    expect(await collect(engine)).toEqual(events);
    expect(seen[0]!.url).toBe('http://cms-api:3100/_cms/internal/ai/chat');
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe('Bearer tok');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      request: {
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        maxOutputTokens: 1000,
      },
    });
    expect(engine.connection).toBe('anthropic-key');
    expect(engine.model).toBe('claude-opus-5-5');
  });

  it('turns HTTP errors into error events', async () => {
    const fetch: FetchLike = async () =>
      Response.json(
        { error: { code: 'limit', message: 'Limite di spesa raggiunto.' } },
        { status: 429 },
      );
    const engine = new GatewayChatEngine({ baseUrl: 'http://cms-api:3100', token: 'tok', fetch });
    expect(await collect(engine)).toEqual([
      { type: 'error', message: 'Limite di spesa raggiunto.', status: 429, retryable: true },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('reports network failures and truncated streams', async () => {
    const down = new GatewayChatEngine({
      baseUrl: 'http://cms-api:3100',
      token: 'tok',
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await collect(down)).toEqual([
      { type: 'error', message: 'Gateway AI non raggiungibile: ECONNREFUSED', retryable: true },
      { type: 'done', stopReason: 'error' },
    ]);
    const cut = new GatewayChatEngine({
      baseUrl: 'http://cms-api:3100',
      token: 'tok',
      fetch: async () => new Response(ndjson([{ type: 'text_delta', text: 'a' }])),
    });
    expect((await collect(cut)).map((e) => e.type)).toEqual(['text_delta', 'error', 'done']);
  });

  it('revives resetsAt dates', async () => {
    const engine = new GatewayChatEngine({
      baseUrl: 'http://cms-api:3100',
      token: 'tok',
      fetch: async () =>
        new Response(
          ndjson([
            {
              type: 'error',
              message: 'Limite',
              rateLimited: true,
              resetsAt: '2026-09-26T12:00:00.000Z',
            },
            { type: 'done', stopReason: 'error' },
          ]),
        ),
    });
    const [error] = await collect(engine);
    expect(error).toMatchObject({ resetsAt: new Date('2026-09-26T12:00:00.000Z') });
  });
});
