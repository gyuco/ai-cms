import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BuilderRun, BuilderRunRequest } from '@ai-cms/pipeline/builder';
import { afterEach, describe, expect, it } from 'vitest';
import { RunConflictError, RunManager } from './runs.ts';
import { createBuilderHandler, parseRunRequest } from './server.ts';

const request: BuilderRunRequest = {
  changesetId: '0b5c7a4e-9d1f-4c3a-8e2b-1f2a3b4c5d6e',
  commit: 'a'.repeat(40),
  databaseUrl: 'postgres://site_app:pw@postgres-staging:5432/app_cs_x',
  checks: ['lint', 'build'],
  pages: ['/'],
  publishedPages: ['/'],
};

/** An execute function that finishes only when released. */
function gate() {
  const releases: Array<() => void> = [];
  const started: string[] = [];
  return {
    started,
    release: () => releases.shift()?.(),
    execute: async (r: BuilderRunRequest, report: (n: never, s: never, o?: string) => void) => {
      started.push(r.changesetId);
      report('lint' as never, 'running' as never);
      await new Promise<void>((resolve) => releases.push(resolve));
      report('lint' as never, 'passed' as never, 'ok');
      report('lint' as never, 'failed' as never, 'ignorato: già concluso');
    },
  };
}

describe('RunManager', () => {
  it('keeps one active run per changeset and records results', async () => {
    const g = gate();
    const runs = new RunManager({ execute: g.execute });
    const run = runs.start(request);
    expect(() => runs.start(request)).toThrow(RunConflictError);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runs.get(run.id)?.checks[0]).toMatchObject({ name: 'lint', status: 'running' });
    g.release();
    await runs.idle();
    const done = runs.get(run.id)!;
    expect(done.status).toBe('finished');
    expect(done.checks).toEqual([
      expect.objectContaining({ name: 'lint', status: 'passed', output: 'ok' }),
      expect.objectContaining({
        name: 'build',
        status: 'failed',
        output: 'Controllo non eseguito dal builder.',
      }),
    ]);
    // Finished: a new run of the same changeset is accepted.
    runs.start(request);
    g.release();
    await runs.idle();
  });

  it('queues runs beyond the concurrency limit', async () => {
    const g = gate();
    const runs = new RunManager({ execute: g.execute, concurrency: 1 });
    const other = { ...request, changesetId: '1b5c7a4e-9d1f-4c3a-8e2b-1f2a3b4c5d6e' };
    runs.start(request);
    const second = runs.start(other);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(g.started).toHaveLength(1);
    expect(runs.get(second.id)?.status).toBe('queued');
    g.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(g.started).toHaveLength(2);
    g.release();
    await runs.idle();
  });

  it('fails the checks when execute throws, and forgets old runs', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const runs = new RunManager({
      execute: async () => {
        throw new Error('disco pieno');
      },
      retentionMs: 1_000,
      now: () => now,
    });
    const run = runs.start(request);
    await runs.idle();
    expect(runs.get(run.id)?.checks.every((c) => c.status === 'failed')).toBe(true);
    expect(runs.get(run.id)?.checks[0]?.output).toMatch(/disco pieno/);
    now = new Date('2026-01-01T00:00:05Z');
    expect(runs.get(run.id)).toBeUndefined();
  });
});

describe('parseRunRequest', () => {
  it('accepts a valid request and rejects bad fields', () => {
    expect(parseRunRequest(request)).toEqual(request);
    expect(parseRunRequest({ ...request, changesetId: '../x' })).toMatch(/changesetId/);
    expect(parseRunRequest({ ...request, commit: 'HEAD' })).toMatch(/commit/);
    expect(parseRunRequest({ ...request, databaseUrl: 'file:///etc/passwd' })).toMatch(
      /databaseUrl/,
    );
    expect(parseRunRequest({ ...request, checks: ['permissions'] })).toMatch(/checks/);
    expect(parseRunRequest({ ...request, pages: ['//evil.example'] })).toMatch(/pages/);
    expect(parseRunRequest(null)).toMatch(/changesetId/);
  });
});

describe('builder HTTP API', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function start(runs: RunManager, deleted: string[] = []) {
    server = createServer(
      createBuilderHandler({
        runs,
        token: 'segreto',
        deleteArtifacts: async (id) => void deleted.push(id),
      }),
    );
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    return (path: string, init: RequestInit & { token?: string } = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${init.token ?? 'segreto'}`,
          'content-type': 'application/json',
        },
      });
  }

  it('requires the token, except for the health check', async () => {
    const call = await start(new RunManager({ execute: async () => {} }));
    expect((await call('/health', { token: 'x' })).status).toBe(200);
    expect((await call('/runs/x', { token: 'sbagliato' })).status).toBe(401);
  });

  it('starts a run, returns it and refuses a second one for the changeset', async () => {
    const g = gate();
    const runs = new RunManager({ execute: g.execute });
    const deleted: string[] = [];
    const call = await start(runs, deleted);
    const created = await call('/runs', { method: 'POST', body: JSON.stringify(request) });
    expect(created.status).toBe(202);
    const run = (await created.json()) as BuilderRun;

    const conflict = await call('/runs', { method: 'POST', body: JSON.stringify(request) });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { run: BuilderRun }).run.id).toBe(run.id);

    g.release();
    await runs.idle();
    const got = await call(`/runs/${run.id}`);
    expect(((await got.json()) as BuilderRun).status).toBe('finished');
    expect((await call('/runs/nessuno')).status).toBe(404);

    const bad = await call('/runs', { method: 'POST', body: '{"commit": 1' });
    expect(bad.status).toBe(400);

    expect((await call(`/changesets/${request.changesetId}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect(deleted).toEqual([request.changesetId]);
    expect((await call('/changesets/..', { method: 'DELETE' })).status).toBe(404);
  });
});
