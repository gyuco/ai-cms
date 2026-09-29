import { randomUUID } from 'node:crypto';
import { ROOT_UID, schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  autofixDedupeKey,
  buildAutofixPrompt,
  DEFAULT_AUTOFIX_ATTEMPTS,
  getChangesetChecksState,
  maxAutofixAttempts,
  planAutofix,
} from './autofix.ts';
import { enqueue } from './queue.ts';

describe('maxAutofixAttempts', () => {
  it('defaults to three rounds (FR-42)', () => {
    expect(DEFAULT_AUTOFIX_ATTEMPTS).toBe(3);
    expect(maxAutofixAttempts({})).toBe(3);
    expect(maxAutofixAttempts({ AUTOFIX_MAX_ATTEMPTS: ' ' })).toBe(3);
  });

  it('is configurable, and 0 turns the correction off', () => {
    expect(maxAutofixAttempts({ AUTOFIX_MAX_ATTEMPTS: '5' })).toBe(5);
    expect(maxAutofixAttempts({ AUTOFIX_MAX_ATTEMPTS: '0' })).toBe(0);
  });

  it('ignores values that make no sense', () => {
    for (const value of ['-1', '2.5', 'molti', '99']) {
      expect(maxAutofixAttempts({ AUTOFIX_MAX_ATTEMPTS: value })).toBe(3);
    }
  });
});

describe('buildAutofixPrompt', () => {
  const failed = [
    { name: 'typecheck' as const, output: "error TS2304: Cannot find name 'x'." },
    { name: 'unit' as const, output: null },
  ];

  it('gives the agent the output of every failed check', () => {
    const prompt = buildAutofixPrompt({
      title: 'Prenotazioni',
      attempt: 1,
      maxAttempts: 3,
      failed,
    });
    expect(prompt).toContain('"Prenotazioni"');
    expect(prompt).toContain('tentativo di correzione 1 di 3');
    expect(prompt).toContain('### typecheck');
    expect(prompt).toContain("Cannot find name 'x'");
    expect(prompt).toContain('### unit\n```\n(nessun output)');
    expect(prompt).not.toContain('ultimo tentativo');
  });

  it('warns the agent on the last attempt', () => {
    const prompt = buildAutofixPrompt({ title: 'T', attempt: 3, maxAttempts: 3, failed });
    expect(prompt).toContain('ultimo tentativo automatico');
  });
});

describe.skipIf(!testDatabaseUrl)('planAutofix and getChangesetChecksState', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async () => 'x' });
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function failedChangeset(status: 'checks_failed' | 'ready' = 'checks_failed') {
    const id = randomUUID();
    const commit = 'a'.repeat(40);
    await database.db.insert(schema.changesets).values({
      id,
      title: 'Prenotazioni',
      branch: `cs/${id}`,
      baseCommit: commit,
      headCommit: commit,
      authorUid: ROOT_UID,
      status,
    });
    await database.db.insert(schema.checkRuns).values([
      { changesetId: id, commit, checkName: 'permissions', status: 'passed', output: 'ok' },
      { changesetId: id, commit, checkName: 'typecheck', status: 'failed', output: 'TS2304' },
      { changesetId: id, commit, checkName: 'lint', status: 'skipped', output: null },
    ]);
    return id;
  }

  it('hands out at most three rounds, then reports the attempts as exhausted', async () => {
    const id = await failedChangeset();
    for (const attempt of [1, 2, 3]) {
      const plan = await planAutofix(database.db, id, 3);
      expect(plan).toMatchObject({ action: 'retry', attempt, maxAttempts: 3 });
      if (plan.action === 'retry') {
        expect(plan.failed).toEqual([{ name: 'typecheck', output: 'TS2304' }]);
      }
    }
    expect(await planAutofix(database.db, id, 3)).toEqual({
      action: 'exhausted',
      attempts: 3,
      maxAttempts: 3,
    });
    const [row] = await database.db
      .select()
      .from(schema.changesets)
      .where(eq(schema.changesets.id, id));
    expect(row?.autofixAttempts).toBe(3);
  });

  it('does not start a round when the changeset is not in checks_failed', async () => {
    const id = await failedChangeset('ready');
    expect(await planAutofix(database.db, id, 3)).toEqual({
      action: 'none',
      reason: 'stato "ready"',
    });
  });

  it('does nothing when the correction is turned off', async () => {
    const id = await failedChangeset();
    expect((await planAutofix(database.db, id, 0)).action).toBe('exhausted');
    expect((await getChangesetChecksState(database.db, id, 0)).autofix.state).toBe('idle');
  });

  it('reports the checks and the state of the correction rounds', async () => {
    const id = await failedChangeset();
    let state = await getChangesetChecksState(database.db, id, 3);
    expect(state).toMatchObject({
      status: 'checks_failed',
      autofix: { state: 'idle', attempts: 0, maxAttempts: 3 },
    });
    expect(state.checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      'permissions:passed',
      'typecheck:failed',
      'lint:skipped',
    ]);

    await planAutofix(database.db, id, 3);
    await enqueue(
      database.db,
      'changeset.autofix',
      { changesetId: id },
      {
        dedupeKey: autofixDedupeKey(id),
      },
    );
    state = await getChangesetChecksState(database.db, id, 3);
    expect(state.autofix).toEqual({ state: 'running', attempts: 1, maxAttempts: 3 });
  });

  it('reports exhausted attempts', async () => {
    const id = await failedChangeset();
    for (let i = 0; i < 3; i++) await planAutofix(database.db, id, 3);
    expect((await getChangesetChecksState(database.db, id, 3)).autofix.state).toBe('exhausted');
  });
});
