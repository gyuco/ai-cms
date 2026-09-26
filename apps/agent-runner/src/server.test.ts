import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunError, type Runner, type RunnerEvent, type RunRequest } from './runner.ts';
import { createRunnerServer } from './server.ts';

let server: ReturnType<typeof createRunnerServer>;
let baseUrl: string;
let started: RunRequest[];

/** Emits two events, then waits for the abort signal when the prompt says so. */
const fakeRunner = {
  busy: new Set<string>(),
  async start(request: RunRequest) {
    if (request.token !== 'tok') throw new RunError(401, 'unauthenticated', 'Token scaduto.');
    started.push(request);
    return {
      whoami: {} as never,
      async execute(emit: (event: RunnerEvent) => void, signal: AbortSignal) {
        emit({ type: 'text_delta', text: 'Lavoro…' });
        if (request.prompt === 'aspetta') {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        }
        const result = {
          type: 'result' as const,
          engine: request.engine,
          agent: 'dev-agent' as const,
          stopReason: signal.aborted ? ('aborted' as const) : ('end_turn' as const),
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          ai: 'native/x',
        };
        emit(result);
        return result;
      },
    };
  },
} as unknown as Runner;

beforeEach(async () => {
  started = [];
  server = createRunnerServer(fakeRunner);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function post(pathname: string, body: unknown) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function lines(res: Response): Promise<Record<string, unknown>[]> {
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('agent-runner HTTP API', () => {
  it('streams a run as NDJSON', async () => {
    const res = await post('/runs', { token: 'tok', engine: 'native', prompt: 'Ciao' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const events = await lines(res);
    expect(events.map((e) => e.type)).toEqual(['run', 'text_delta', 'result']);
    expect(events[0]!.runId).toBe(res.headers.get('x-run-id'));
    expect(started).toEqual([{ token: 'tok', engine: 'native', prompt: 'Ciao' }]);
  });

  it('answers with HTTP errors before streaming', async () => {
    const bad = await post('/runs', { token: 'tok', engine: 'gpt', prompt: 'x' });
    expect(bad.status).toBe(400);
    const unauthenticated = await post('/runs', { token: 'x', engine: 'native', prompt: 'x' });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Token scaduto.' },
    });
    expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it('cancels a run with its token only', async () => {
    const res = await post('/runs', { token: 'tok', engine: 'native', prompt: 'aspetta' });
    const runId = res.headers.get('x-run-id')!;
    expect((await post(`/runs/${runId}/cancel`, { token: 'other' })).status).toBe(404);
    expect((await post('/runs/unknown/cancel', { token: 'tok' })).status).toBe(404);
    const cancel = await post(`/runs/${runId}/cancel`, { token: 'tok' });
    expect(cancel.status).toBe(202);
    const events = await lines(res);
    expect(events.at(-1)).toMatchObject({ type: 'result', stopReason: 'aborted' });
    expect(server.runs.size).toBe(0);
  });
});
