import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import { createSseParser, streamChat, type ChatEvent } from './stream.ts';

const frame = (event: ChatEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

describe('createSseParser', () => {
  it('emits an event once its frame is complete, whatever the chunking', () => {
    const events: ChatEvent[] = [];
    const parser = createSseParser((e) => events.push(e));
    const text =
      frame({ type: 'text', text: 'Ciao' }) + frame({ type: 'done', stopReason: 'end_turn' });

    for (const char of text) parser.push(char);

    expect(events).toEqual([
      { type: 'text', text: 'Ciao' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('handles CRLF and ignores frames that are not JSON', () => {
    const events: ChatEvent[] = [];
    const parser = createSseParser((e) => events.push(e));
    parser.push(': keep-alive\r\n\r\ndata: non json\r\n\r\n');
    parser.push('data: {"type":"status","state":"thinking"}\r\n\r\n');
    expect(events).toEqual([{ type: 'status', state: 'thinking' }]);
  });
});

describe('streamChat', () => {
  const request = { message: 'Ciao', conversationId: null, path: '/site/pages/x', selected: null };

  it('posts with the CSRF token and delivers the streamed events', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        const text = frame({ type: 'text', text: 'Ci' }) + frame({ type: 'text', text: 'ao' });
        controller.enqueue(encoder.encode(text.slice(0, 20)));
        controller.enqueue(encoder.encode(text.slice(20)));
        controller.close();
      },
    });
    const fetchFn = vi.fn(async () => new Response(body, { status: 200 }));
    const events: ChatEvent[] = [];

    await streamChat('csrf-1', request, (e) => events.push(e), undefined, fetchFn as never);

    expect(events.map((e) => (e.type === 'text' ? e.text : e.type))).toEqual(['Ci', 'ao']);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/_cms/api/chat');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-1');
    expect(JSON.parse(init.body as string)).toMatchObject({ message: 'Ciao' });
  });

  it('rejects with the message of the server when the request is refused', async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({ error: { code: 'bad_request', message: 'Messaggio vuoto.' } }),
        {
          status: 400,
        },
      );
    await expect(
      streamChat('c', request, () => undefined, undefined, fetchFn as never),
    ).rejects.toEqual(expect.objectContaining({ status: 400, message: 'Messaggio vuoto.' }));
    await expect(
      streamChat('c', request, () => undefined, undefined, fetchFn as never),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
