import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_UID, schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readCurrentRelease, ReleaseBusyError, switchCurrentRelease } from './release.ts';
import { listReleases } from './release-history.ts';
import { requestRollback, ROLLBACK_JOB, runRollback, type RollbackOptions } from './rollback.ts';

describe.skipIf(!testDatabaseUrl)('rollback and history of the releases', () => {
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

  const options = (patch: Partial<RollbackOptions> = {}): RollbackOptions => ({
    releasesRoot,
    ...patch,
  });
  const releaseRow = async (id: string) =>
    (await database.db.select().from(schema.releases).where(eq(schema.releases.id, id)))[0]!;
  const auditActions = async () =>
    (await database.db.select().from(schema.auditLog)).map((row) => `${row.action}:${row.outcome}`);

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

  describe('requestRollback', () => {
    it('queues the job for the release in production and names where it goes back to', async () => {
      const one = await release(1);
      const two = await release(2);
      const result = await requestRollback(database.db, {
        releaseId: two.release.id,
        actorUid: ROOT_UID,
      });
      expect(result).toEqual({
        releaseId: two.release.id,
        releaseNumber: 2,
        toReleaseId: one.release.id,
        toReleaseNumber: 1,
      });
      const jobs = (await database.db.select().from(schema.jobs)).filter(
        (job) => job.type === ROLLBACK_JOB,
      );
      expect(jobs.map((job) => job.payload)).toEqual([
        { releaseId: two.release.id, actorUid: ROOT_UID },
      ]);
      expect(await auditActions()).toContain('release.rollback.request:ok');
    });

    it('does not queue it twice for the same release', async () => {
      await release(1);
      const two = await release(2);
      const input = { releaseId: two.release.id, actorUid: ROOT_UID };
      await requestRollback(database.db, input);
      await requestRollback(database.db, input);
      expect((await database.db.select().from(schema.jobs)).length).toBe(1);
    });

    it('refuses a release that is not the newest successful one', async () => {
      const one = await release(1);
      await release(2);
      await expect(
        requestRollback(database.db, { releaseId: one.release.id, actorUid: ROOT_UID }),
      ).rejects.toThrow(/ultima release pubblicata \(2\)/);
    });

    it('refuses the first release, a failed one and an unknown one', async () => {
      const one = await release(1);
      await expect(
        requestRollback(database.db, { releaseId: one.release.id, actorUid: ROOT_UID }),
      ).rejects.toThrow(/Non esiste una release precedente/);
      const failed = await release(2, { status: 'failed', error: 'health' });
      await expect(
        requestRollback(database.db, { releaseId: failed.release.id, actorUid: ROOT_UID }),
      ).rejects.toThrow(/"failed"/);
      await expect(
        requestRollback(database.db, {
          releaseId: '00000000-0000-4000-8000-000000000000',
          actorUid: ROOT_UID,
        }),
      ).rejects.toThrow(/non trovata/);
    });
  });

  describe('runRollback', () => {
    it('switches to the previous artifact, restarts, health checks and records it', async () => {
      const one = await release(1);
      const two = await release(2);
      await switchCurrentRelease(releasesRoot, two.release.id);
      const calls: string[] = [];
      const outcome = await runRollback(
        database.db,
        two.release.id,
        ROOT_UID,
        options({
          restart: async () => void calls.push('restart'),
          healthCheck: async () =>
            void calls.push(`health:${(await readCurrentRelease(releasesRoot)) ?? ''}`),
        }),
      );
      expect(outcome).toEqual({
        status: 'rolled_back',
        releaseId: two.release.id,
        number: 2,
        toReleaseId: one.release.id,
      });
      expect(calls).toEqual(['restart', `health:${one.release.id}`]);
      expect(await readCurrentRelease(releasesRoot)).toBe(one.release.id);
      expect((await releaseRow(two.release.id)).status).toBe('rolled_back');
      expect((await releaseRow(one.release.id)).status).toBe('released');
      const [changeset] = await database.db
        .select()
        .from(schema.changesets)
        .where(eq(schema.changesets.id, two.changesetId));
      expect(changeset?.status).toBe('rolled_back');
      expect(await auditActions()).toContain('release.rollback:ok');
    });

    it('can go back step by step, and a rolled back release is never current again', async () => {
      const one = await release(1);
      const two = await release(2);
      const three = await release(3);
      await switchCurrentRelease(releasesRoot, three.release.id);
      await runRollback(database.db, three.release.id, ROOT_UID, options());
      await runRollback(database.db, two.release.id, ROOT_UID, options());
      expect(await readCurrentRelease(releasesRoot)).toBe(one.release.id);
      const history = await listReleases(database.db);
      expect(history.releases.map((r) => [r.number, r.status, r.current])).toEqual([
        [3, 'rolled_back', false],
        [2, 'rolled_back', false],
        [1, 'released', true],
      ]);
      expect(history.releases.some((r) => r.canRollback)).toBe(false);
    });

    it('puts the pointer back when the site does not answer on the previous release', async () => {
      await release(1);
      const two = await release(2);
      await switchCurrentRelease(releasesRoot, two.release.id);
      const outcome = await runRollback(
        database.db,
        two.release.id,
        ROOT_UID,
        options({
          healthCheck: async () => {
            throw new Error('HTTP 502');
          },
        }),
      );
      expect(outcome).toMatchObject({ status: 'failed' });
      expect(outcome.status === 'failed' && outcome.error).toContain('HTTP 502');
      expect(await readCurrentRelease(releasesRoot)).toBe(two.release.id);
      expect((await releaseRow(two.release.id)).status).toBe('released');
      expect(await auditActions()).toContain('release.rollback:error');
    });

    it('fails without touching the pointer when the previous artifact is gone', async () => {
      const one = await release(1);
      const two = await release(2);
      await rm(join(releasesRoot, one.release.id), { recursive: true });
      await switchCurrentRelease(releasesRoot, two.release.id);
      const outcome = await runRollback(database.db, two.release.id, ROOT_UID, options());
      expect(outcome).toMatchObject({ status: 'failed' });
      expect(await readCurrentRelease(releasesRoot)).toBe(two.release.id);
      expect((await releaseRow(two.release.id)).status).toBe('released');
    });

    it('skips a release that is not published and waits while a release runs', async () => {
      await release(1);
      const failed = await release(2, { status: 'failed' });
      expect(await runRollback(database.db, failed.release.id, ROOT_UID, options())).toMatchObject({
        status: 'skipped',
      });

      const three = await release(3);
      await database.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('release-run'))`);
        await expect(
          runRollback(database.db, three.release.id, ROOT_UID, options()),
        ).rejects.toBeInstanceOf(ReleaseBusyError);
      });
    });
  });
});
