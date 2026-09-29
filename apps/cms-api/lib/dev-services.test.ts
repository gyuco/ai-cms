import { schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevServices, QUERY_ROW_LIMIT, type StagingQuery } from './dev-services.ts';

const ID = '7d1d7e0e-3b0a-4a51-8d5e-0c2a0d0c0001';
const COMMIT = 'a'.repeat(40);

describe.skipIf(!testDatabaseUrl)('developer agent services (E10.6)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const queries: string[] = [];
  const query: StagingQuery = async (_id, statement, limit) => {
    queries.push(statement);
    return { columns: ['n'], rows: Array.from({ length: limit + 1 }, (_, i) => [i]) };
  };
  const services = () => createDevServices({ db: database.db, query, previewSuffix: '.test' });

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
    await database.db.insert(schema.changesets).values({
      id: ID,
      title: 'Blog',
      branch: `cs/${ID}`,
      baseCommit: COMMIT,
      headCommit: COMMIT,
      authorUid: 0,
      status: 'checks_failed',
    });
    await database.db.insert(schema.checkRuns).values([
      {
        changesetId: ID,
        commit: COMMIT,
        checkName: 'typecheck',
        status: 'failed',
        output: 'TS2322',
      },
      { changesetId: ID, commit: COMMIT, checkName: 'lint', status: 'passed' },
    ]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('summarizes the checks of the latest commit', async () => {
    const state = await services().getCheckResults(ID);
    expect(state).toMatchObject({ changesetStatus: 'checks_failed', commit: COMMIT, ok: false });
    expect(state.failed).toEqual(['typecheck']);
    expect(state.checks.find((c) => c.name === 'typecheck')?.output).toBe('TS2322');
    expect(state.pending).toContain('build');
  });

  it('queues one check job at a time', async () => {
    expect(await services().runChecks(ID)).toEqual({ queued: true });
    expect(await services().runChecks(ID)).toEqual({ queued: false });
  });

  it('refuses unknown changesets and invalid ids', async () => {
    await expect(
      services().getCheckResults('7d1d7e0e-3b0a-4a51-8d5e-0c2a0d0c0002'),
    ).rejects.toThrow(/non trovato/);
    await expect(services().runChecks('../x')).rejects.toThrow(/non valido/);
  });

  it('caps the rows of a query and says so', async () => {
    const result = await services().queryStagingDb(ID, 'SELECT n FROM t');
    expect(result.rows).toHaveLength(QUERY_ROW_LIMIT);
    expect(result.truncated).toBe(true);
    expect(queries).toEqual(['SELECT n FROM t']);
  });

  it('gives the preview host and whether a build exists', async () => {
    expect(await services().previewUrl(ID)).toEqual({ url: `http://cs-${ID}.test`, ready: false });
  });
});
