import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runAgent, type AgentEvent } from './agent.ts';
import { defineTool } from './tools.ts';
import type { ChatEngine, ChatEvent, ChatMessage, ChatRequest, ModelCaps } from './types.ts';

const MODEL = 'claude-opus-5-5';

/** Plays one scripted turn per call and records the requests it received. */
function scriptedEngine(
  turns: Array<ChatEvent[] | ((req: ChatRequest) => AsyncIterable<ChatEvent>)>,
) {
  const requests: ChatRequest[] = [];
  const engine: ChatEngine = {
    provider: 'anthropic',
    capabilities: async (): Promise<ModelCaps> => ({ tools: true, vision: true, streaming: true }),
    async *stream(req) {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      const turn = turns[requests.length - 1];
      if (!turn) throw new Error('no more scripted turns');
      if (typeof turn === 'function') yield* turn(req);
      else yield* turn;
    },
  };
  return { engine, requests };
}

const usage = (input: number, output: number, cacheRead = 0): ChatEvent => ({
  type: 'usage',
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
});

const userMessage: ChatMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'Aggiorna la home' }],
};

function makeTools() {
  const readPage = defineTool({
    name: 'read_page',
    description: 'Reads a page',
    input: z.object({ path: z.string() }),
    run: vi.fn(async ({ path }: { path: string }) => ({ path, title: 'Home' })),
  });
  const writePage = defineTool({
    name: 'write_page',
    description: 'Writes a page',
    action: 'write',
    input: z.object({ path: z.string(), html: z.string() }),
    run: vi.fn(async (): Promise<string> => {
      throw new Error('Permesso negato: scrittura su /system non consentita');
    }),
  });
  return { readPage, writePage };
}

describe('runAgent', () => {
  it('runs tools until end_turn and returns produced messages and total usage', async () => {
    const { readPage } = makeTools();
    const { engine, requests } = scriptedEngine([
      [
        { type: 'reasoning', provider: 'anthropic', data: { type: 'thinking', signature: 's' } },
        { type: 'text_delta', text: 'Leggo ' },
        { type: 'text_delta', text: 'la pagina.' },
        { type: 'tool_call', id: 't1', name: 'read_page', input: { path: '/site' } },
        usage(100, 20),
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'Fatto.' },
        usage(150, 5, 90),
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent({
      engine,
      model: MODEL,
      system: 'sys',
      messages: [userMessage],
      tools: [readPage],
      onEvent: (e) => events.push(e),
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(2);
    expect(result.usage).toEqual({
      inputTokens: 250,
      outputTokens: 25,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
    });
    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', provider: 'anthropic', data: { type: 'thinking', signature: 's' } },
          { type: 'text', text: 'Leggo la pagina.' },
          { type: 'tool_call', id: 't1', name: 'read_page', input: { path: '/site' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 't1', content: '{"path":"/site","title":"Home"}' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Fatto.' }] },
    ]);
    expect(requests[0]).toMatchObject({ model: MODEL, system: 'sys', messages: [userMessage] });
    expect(requests[0]?.tools[0]).toMatchObject({
      name: 'read_page',
      inputSchema: { type: 'object' },
    });
    expect(requests[1]?.messages).toEqual([userMessage, ...result.messages.slice(0, 2)]);
    expect(events).toContainEqual({
      type: 'tool_result',
      toolCallId: 't1',
      name: 'read_page',
      content: '{"path":"/site","title":"Home"}',
      isError: false,
    });
    expect(events.filter((e) => e.type === 'step')).toHaveLength(2);
  });

  it('runs parallel calls concurrently and returns every result in one message', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = defineTool({
      name: 'slow',
      description: 'Waits',
      input: z.object({ id: z.string() }),
      run: async ({ id }) => {
        started.push(id);
        if (started.length === 3) release();
        await gate;
        return `ok ${id}`;
      },
    });
    const { writePage } = makeTools();
    const { engine } = scriptedEngine([
      [
        { type: 'tool_call', id: 'a', name: 'slow', input: { id: 'a' } },
        { type: 'tool_call', id: 'b', name: 'slow', input: { id: 'b' } },
        { type: 'tool_call', id: 'c', name: 'slow', input: { id: 'c' } },
        { type: 'tool_call', id: 'd', name: 'slow', input: { id: 42 } },
        { type: 'tool_call', id: 'e', name: 'write_page', input: { path: '/system', html: '' } },
        { type: 'tool_call', id: 'f', name: 'missing', input: {} },
        { type: 'tool_call', id: 'g', name: 'slow', input: '{"id": "g' },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'done', stopReason: 'end_turn' }],
    ]);
    const result = await runAgent({
      engine,
      model: MODEL,
      system: '',
      messages: [userMessage],
      tools: [slow, writePage],
    });

    expect(result.stopReason).toBe('end_turn');
    const toolMessage = result.messages[1];
    expect(toolMessage?.role).toBe('user');
    const results = toolMessage!.content;
    expect(results.map((r) => (r.type === 'tool_result' ? r.toolCallId : null))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
    expect(results[0]).toEqual({ type: 'tool_result', toolCallId: 'a', content: 'ok a' });
    expect(results[3]).toMatchObject({
      isError: true,
      content: expect.stringMatching(/^Input non valido per slow:/),
    });
    expect(results[4]).toEqual({
      type: 'tool_result',
      toolCallId: 'e',
      content: 'Permesso negato: scrittura su /system non consentita',
      isError: true,
    });
    expect(results[5]).toMatchObject({ isError: true, content: 'Strumento sconosciuto: missing' });
    expect(results[6]).toMatchObject({ isError: true, content: expect.stringContaining('JSON') });
  });

  it('stops at maxSteps', async () => {
    const { readPage } = makeTools();
    const turn: ChatEvent[] = [
      { type: 'tool_call', id: 'x', name: 'read_page', input: { path: '/' } },
      { type: 'done', stopReason: 'tool_use' },
    ];
    const { engine, requests } = scriptedEngine([turn, turn, turn]);
    const result = await runAgent({
      engine,
      model: MODEL,
      system: '',
      messages: [userMessage],
      tools: [readPage],
      maxSteps: 2,
    });
    expect(result.stopReason).toBe('max_steps');
    expect(result.steps).toBe(2);
    expect(requests).toHaveLength(2);
    // History stays valid: the last tool calls have their results.
    expect(result.messages.at(-1)?.role).toBe('user');
  });

  it('asks for confirmation and reports a refusal as an error result', async () => {
    const { readPage } = makeTools();
    const confirm = vi.fn(async () => false);
    const { engine } = scriptedEngine([
      [
        { type: 'tool_call', id: 't', name: 'read_page', input: { path: '/' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'done', stopReason: 'end_turn' }],
    ]);
    const result = await runAgent({
      engine,
      model: MODEL,
      system: '',
      messages: [userMessage],
      tools: [readPage],
      confirm,
    });
    expect(confirm).toHaveBeenCalledWith(
      { type: 'tool_call', id: 't', name: 'read_page', input: { path: '/' } },
      readPage,
    );
    expect(readPage.run).not.toHaveBeenCalled();
    expect(result.messages[1]?.content[0]).toMatchObject({ isError: true });
  });

  it('can be aborted while the model is streaming', async () => {
    const controller = new AbortController();
    const { readPage } = makeTools();
    const { engine } = scriptedEngine([
      async function* () {
        yield { type: 'text_delta', text: 'Inizio' };
        yield { type: 'tool_call', id: 't', name: 'read_page', input: { path: '/' } };
        controller.abort();
        yield { type: 'error', message: 'Richiesta interrotta', aborted: true };
        yield { type: 'done', stopReason: 'error' };
      },
    ]);
    const result = await runAgent({
      engine,
      model: MODEL,
      system: '',
      messages: [userMessage],
      tools: [readPage],
      signal: controller.signal,
    });
    expect(result.stopReason).toBe('aborted');
    expect(readPage.run).not.toHaveBeenCalled();
    // Unanswerable tool calls are dropped, the partial text is kept.
    expect(result.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'Inizio' }] },
    ]);
  });

  it('can be aborted between steps, passing the signal to tools', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const stop = defineTool({
      name: 'stop',
      description: 'Stops',
      input: z.object({}),
      run: (_input, ctx) => {
        seen.push(ctx.signal);
        controller.abort();
        return 'ok';
      },
    });
    const { engine, requests } = scriptedEngine([
      [
        { type: 'tool_call', id: 't', name: 'stop', input: {} },
        { type: 'done', stopReason: 'tool_use' },
      ],
    ]);
    const result = await runAgent({
      engine,
      model: MODEL,
      system: '',
      messages: [userMessage],
      tools: [stop],
      signal: controller.signal,
    });
    expect(result.stopReason).toBe('aborted');
    expect(seen).toEqual([controller.signal]);
    expect(requests).toHaveLength(1);
    expect(result.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: 't', content: 'ok' }],
    });
  });

  it('does not run tools cut off by max_tokens', async () => {
    const { readPage } = makeTools();
    const { engine } = scriptedEngine([
      [
        { type: 'tool_call', id: 't', name: 'read_page', input: { path: '/' } },
        { type: 'done', stopReason: 'max_tokens' },
      ],
    ]);
    const result = await runAgent({
      engine,
      model: MODEL,
      system: '',
      messages: [userMessage],
      tools: [readPage],
    });
    expect(result.stopReason).toBe('max_tokens');
    expect(readPage.run).not.toHaveBeenCalled();
    expect(result.messages[1]?.content[0]).toMatchObject({ toolCallId: 't', isError: true });
  });

  it('stops on refusal and on engine errors', async () => {
    const { readPage } = makeTools();
    const refused = scriptedEngine([
      [
        { type: 'tool_call', id: 't', name: 'read_page', input: { path: '/' } },
        { type: 'done', stopReason: 'refusal', detail: 'Non posso.' },
      ],
    ]);
    const r1 = await runAgent({
      engine: refused.engine,
      model: 'claude-sonnet-5',
      system: '',
      messages: [userMessage],
      tools: [readPage],
    });
    expect(r1).toMatchObject({ stopReason: 'refusal', detail: 'Non posso.', messages: [] });
    expect(readPage.run).not.toHaveBeenCalled();

    const failing = scriptedEngine([
      [
        { type: 'error', message: 'overloaded', retryable: true },
        { type: 'done', stopReason: 'error' },
      ],
    ]);
    const r2 = await runAgent({
      engine: failing.engine,
      model: MODEL,
      system: '',
      messages: [userMessage],
      tools: [],
    });
    expect(r2).toMatchObject({ stopReason: 'error', detail: 'overloaded', steps: 1 });
  });
});
