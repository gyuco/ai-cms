import { contentAgentProfile, devAgentProfile, type Principal } from '@ai-cms/authz';
import { describe, expect, it, vi } from 'vitest';
import { createToolRegistry, registerTools } from '../registry.ts';
import type { DevChecksState, DevExtra, DevServices } from './context.ts';
import { devTools, readOnlyProblem } from './tools.ts';

const CHANGESET = '5b3c1f52-2f0b-4f4c-9d64-1a1a1a1a1a1a';

const state: DevChecksState = {
  changesetStatus: 'checks_failed',
  commit: 'abc',
  ok: false,
  failed: ['typecheck'],
  pending: [],
  checks: [
    { name: 'typecheck', status: 'failed', output: 'x'.repeat(5000) },
    { name: 'lint', status: 'passed', output: null },
  ],
};

function services(): DevServices {
  return {
    runChecks: vi.fn(async () => ({ queued: true })),
    getCheckResults: vi.fn(async () => state),
    queryStagingDb: vi.fn(async () => ({ columns: ['n'], rows: [[1]], truncated: false })),
    previewUrl: vi.fn(async () => ({ url: `http://cs-${CHANGESET}.localhost`, ready: true })),
  };
}

const user = (profile?: Principal['agent']): Principal => ({
  uid: 1,
  username: 'ada',
  status: 'active',
  ...(profile ? { agent: profile } : {}),
});

function setup(
  options: { principal?: Principal; env?: 'prod' | 'staging'; changesetId?: string | null } = {},
) {
  const dev = services();
  const registry = createToolRegistry<DevExtra>();
  registerTools(registry, devTools);
  const ctx = {
    principal: options.principal ?? user(devAgentProfile),
    env: options.env ?? 'staging',
    dev,
    changesetId: options.changesetId === undefined ? CHANGESET : options.changesetId,
    toolCallId: 't1',
  };
  return { dev, call: (name: string, input: unknown = {}) => registry.call(name, input, ctx) };
}

describe('developer tools', () => {
  it('registers the four tools of TECHNICAL §7.6', () => {
    const names = devTools.map((tool) => tool.name);
    expect(names).toEqual(['run_checks', 'get_check_results', 'query_staging_db', 'open_preview']);
  });

  it('queues the checks of the session changeset', async () => {
    const { dev, call } = setup();
    const result = await call('run_checks');
    expect(result.isError).toBe(false);
    expect(dev.runChecks).toHaveBeenCalledWith(CHANGESET);
  });

  it('reports a run already in progress', async () => {
    const { dev, call } = setup();
    vi.mocked(dev.runChecks).mockResolvedValueOnce({ queued: false });
    expect((await call('run_checks')).content).toMatch(/già in corso/);
  });

  it('returns the results with a clipped output', async () => {
    const { call } = setup();
    const result = await call('get_check_results');
    const parsed = JSON.parse(result.content) as DevChecksState;
    expect(parsed.failed).toEqual(['typecheck']);
    expect(parsed.checks[0]!.output!.length).toBeLessThan(4_100);
    expect(parsed.checks[0]!.output).toMatch(/caratteri omessi/);
  });

  it('runs a read-only query on the changeset database', async () => {
    const { dev, call } = setup();
    const result = await call('query_staging_db', { sql: 'SELECT count(*) AS n FROM pages;' });
    expect(result.isError).toBe(false);
    expect(dev.queryStagingDb).toHaveBeenCalledWith(CHANGESET, 'SELECT count(*) AS n FROM pages');
  });

  it.each([
    'DELETE FROM pages',
    'DROP TABLE pages',
    'SELECT 1; DROP TABLE pages',
    'WITH x AS (DELETE FROM pages RETURNING *) SELECT * FROM x',
    "COPY pages TO PROGRAM 'curl x'",
  ])('refuses %s before it reaches the database', async (sql) => {
    const { dev, call } = setup();
    const result = await call('query_staging_db', { sql });
    expect(result.isError).toBe(true);
    expect(dev.queryStagingDb).not.toHaveBeenCalled();
  });

  it('gives the preview address', async () => {
    const { call } = setup();
    const result = await call('open_preview');
    expect(JSON.parse(result.content)).toEqual({
      url: `http://cs-${CHANGESET}.localhost`,
      ready: true,
    });
  });

  it.each(['run_checks', 'get_check_results', 'open_preview'])(
    '%s is closed to the content agent',
    async (name) => {
      const { dev, call } = setup({ principal: user(contentAgentProfile) });
      const result = await call(name);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/Permesso negato|agente sviluppatore/);
      expect(dev.runChecks).not.toHaveBeenCalled();
      expect(dev.getCheckResults).not.toHaveBeenCalled();
      expect(dev.previewUrl).not.toHaveBeenCalled();
    },
  );

  it('is closed to a plain user session too (no agent profile)', async () => {
    const { dev, call } = setup({ principal: user() });
    expect((await call('run_checks')).isError).toBe(true);
    expect(dev.runChecks).not.toHaveBeenCalled();
  });

  it('never runs in production', async () => {
    const { dev, call } = setup({ env: 'prod' });
    for (const name of ['run_checks', 'get_check_results', 'open_preview']) {
      expect((await call(name)).isError).toBe(true);
    }
    expect((await call('query_staging_db', { sql: 'SELECT 1' })).isError).toBe(true);
    expect(dev.runChecks).not.toHaveBeenCalled();
    expect(dev.queryStagingDb).not.toHaveBeenCalled();
  });

  it('needs a changeset', async () => {
    const { dev, call } = setup({ changesetId: null });
    const result = await call('run_checks');
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/changeset/);
    expect(dev.runChecks).not.toHaveBeenCalled();
  });
});

describe('readOnlyProblem', () => {
  it('accepts plain reads', () => {
    expect(readOnlyProblem('SELECT * FROM pages')).toBeNull();
    expect(readOnlyProblem('with a as (select 1) select * from a;')).toBeNull();
    expect(readOnlyProblem('EXPLAIN SELECT 1')).toBeNull();
  });
});
