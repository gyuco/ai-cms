import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_UID, schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listReleases } from './release-history.ts';

describe.skipIf(!testDatabaseUrl)('the history of the releases', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let dir: string;
  let releasesRoot: string;

  /** Inserts a changeset and a release that carries it. */
  async function release(number: number, patch: Partial<typeof schema.releases.$inferInsert> = {}) {
    const [cs] = await database.db
      .insert(schema.changesets)
      .values({
        title: `Modifica ${String(number)}`,
        branch: `cs/test-${String(number)}-${String(Math.random()).slice(2, 8)}`,
        baseCommit: 'base',
        authorUid: ROOT_UID,
        status: 'released',
      })
      .returning();
    const [row] = await database.db
      .insert(schema.releases)
      .values({
        number,
        changesetIds: [cs!.id],
        commit: `commit${String(number)}`,
        status: 'released',
        approvedBy: ROOT_UID,
        finishedAt: new Date(),
        ...patch,
      })
      .returning();
    await mkdir(join(releasesRoot, row!.id), { recursive: true });
    return { release: row!, changesetId: cs!.id };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async () => 'x' });
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-rollback-'));
  });

  beforeEach(async () => {
    await database.db.delete(schema.releases);
    await database.db.delete(schema.jobs);
    releasesRoot = await mkdtemp(join(dir, 'releases-'));
  });

  afterAll(async () => {
    await database?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  describe('listReleases', () => {
    it('lists newest first with author, approver, dates, changesets and outcome', async () => {
      await release(1);
      await release(2, { status: 'failed', error: 'health check fallito', finishedAt: null });
      await release(3);
      const history = await listReleases(database.db);
      expect(history.nextBefore).toBeNull();
      expect(history.releases.map((r) => [r.number, r.tag, r.status])).toEqual([
        [3, 'release-3', 'released'],
        [2, 'release-2', 'failed'],
        [1, 'release-1', 'released'],
      ]);
      const [latest, failed] = history.releases;
      expect(latest).toMatchObject({
        commit: 'commit3',
        current: true,
        canRollback: true,
        error: null,
        approvedBy: { uid: ROOT_UID, username: 'root' },
        changesets: [{ title: 'Modifica 3', author: { uid: ROOT_UID, username: 'root' } }],
      });
      expect(typeof latest?.createdAt).toBe('string');
      expect(typeof latest?.finishedAt).toBe('string');
      expect(failed).toMatchObject({
        current: false,
        canRollback: false,
        error: 'health check fallito',
        finishedAt: null,
      });
    });

    it('pages with limit and before', async () => {
      for (const n of [1, 2, 3]) await release(n);
      const first = await listReleases(database.db, { limit: 2 });
      expect(first.releases.map((r) => r.number)).toEqual([3, 2]);
      expect(first.nextBefore).toBe(2);
      const second = await listReleases(database.db, { limit: 2, before: first.nextBefore! });
      expect(second.releases.map((r) => r.number)).toEqual([1]);
      expect(second.nextBefore).toBeNull();
      expect(first.releases[0]?.current).toBe(true);
      expect(second.releases[0]?.canRollback).toBe(false);
    });

    it('is empty without releases', async () => {
      expect(await listReleases(database.db)).toEqual({ releases: [], nextBefore: null });
    });
  });
});
