import { describe, expect, it } from 'vitest';
import { createBuilderClient } from './builder-client.ts';
import {
  isChangesetId,
  isCommitId,
  summarizeChecks,
  truncateOutput,
  type BuilderRun,
} from './builder-protocol.ts';

describe('truncateOutput', () => {
  it('keeps short output as is', () => {
    expect(truncateOutput('ok')).toBe('ok');
  });

  it('keeps the beginning and the end of long output within the limit', () => {
    const text = `INIZIO\n${'x'.repeat(10_000)}\nFINE`;
    const out = truncateOutput(text, 2_000);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2_000);
    expect(out.startsWith('INIZIO')).toBe(true);
    expect(out.endsWith('FINE')).toBe(true);
    expect(out).toMatch(/output troncato: \d+ byte omessi/);
  });
});

describe('summarizeChecks', () => {
  it('is ok when every check passed or was skipped', () => {
    expect(
      summarizeChecks([
        { name: 'lint', status: 'passed' },
        { name: 'a11y', status: 'skipped' },
      ]),
    ).toEqual({ ok: true, failed: [], skipped: ['a11y'], pending: [] });
  });

  it('is not ok with failed or unfinished checks', () => {
    expect(
      summarizeChecks([
        { name: 'lint', status: 'failed' },
        { name: 'build', status: 'running' },
      ]),
    ).toMatchObject({ ok: false, failed: ['lint'], pending: ['build'] });
    expect(summarizeChecks([{ name: 'build', status: 'queued' }]).ok).toBe(false);
  });
});

describe('ids', () => {
  it('validates changeset and commit ids', () => {
    expect(isChangesetId('0b5c7a4e-9d1f-4c3a-8e2b-1f2a3b4c5d6e')).toBe(true);
    expect(isChangesetId('../etc')).toBe(false);
    expect(isCommitId('a'.repeat(40))).toBe(true);
    expect(isCommitId('HEAD')).toBe(false);
  });
});

describe('createBuilderClient', () => {
  const run: BuilderRun = {
    id: 'r1',
    changesetId: 'c',
    commit: 'a'.repeat(40),
    status: 'running',
    checks: [],
    createdAt: '',
    finishedAt: null,
  };
  const request = {
    changesetId: 'c',
    commit: 'a'.repeat(40),
    databaseUrl: 'postgres://x',
    checks: [],
    pages: ['/'],
    publishedPages: ['/'],
  };

  function client(status: number, body: unknown, calls: Request[] = []) {
    return createBuilderClient({
      url: 'http://builder:8090/',
      token: () => 'segreto',
      fetch: async (input, init) => {
        calls.push(new Request(input as string, init));
        return new Response(JSON.stringify(body), { status });
      },
    });
  }

  it('sends the token and returns the run', async () => {
    const calls: Request[] = [];
    expect(await client(202, run, calls).startRun(request)).toEqual(run);
    expect(calls[0]!.url).toBe('http://builder:8090/runs');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer segreto');
  });

  it('joins the active run of the same commit and refuses another', async () => {
    expect(await client(409, { error: 'busy', run }).startRun(request)).toEqual(run);
    await expect(
      client(409, { error: 'busy', run: { ...run, commit: 'b'.repeat(40) } }).startRun(request),
    ).rejects.toThrow(/409: busy/);
  });

  it('reports network errors in Italian', async () => {
    const broken = createBuilderClient({
      url: 'http://builder:8090',
      token: () => 't',
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(broken.getRun('r1')).rejects.toThrow(/non risponde \(ECONNREFUSED\)/);
  });
});
