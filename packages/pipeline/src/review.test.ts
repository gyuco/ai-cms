import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_UID, schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChangeset, workspacePath, type Changeset } from './changesets.ts';
import { runGit } from './git.ts';
import {
  approveChangeset,
  buildChangeRequestPrompt,
  RELEASE_JOB,
  rejectChangeset,
  REVISE_JOB,
} from './review.ts';
import { initSiteRepo, type SiteRepoPaths } from './site-repo.ts';

describe('buildChangeRequestPrompt', () => {
  it('carries the reviewer comment to the agent', () => {
    const prompt = buildChangeRequestPrompt({
      title: 'Catalogo',
      reviewerUsername: 'marta',
      comment: '  Il prezzo va in centesimi.  ',
    });
    expect(prompt).toContain('"Catalogo"');
    expect(prompt).toContain('da marta');
    expect(prompt).toContain('Il prezzo va in centesimi.');
  });
});

describe.skipIf(!testDatabaseUrl)('approval and rejection of a changeset', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let dir: string;
  let paths: SiteRepoPaths;

  async function readyChangeset(patch: Partial<Changeset> = {}) {
    const cs = await createChangeset(database.db, { title: 'Pagine', authorUid: ROOT_UID }, paths);
    const cwd = workspacePath(paths, cs.id);
    await writeFile(join(cwd, 'lib.ts'), 'export const x = 1;\n');
    await runGit(['add', '--all'], { cwd });
    await runGit(['commit', '--quiet', '-m', 'edit'], { cwd });
    const head = (await runGit(['rev-parse', 'HEAD'], { cwd })).trim();
    await database.db
      .update(schema.changesets)
      .set({ status: 'ready', headCommit: head, ...patch })
      .where(eq(schema.changesets.id, cs.id));
    return { id: cs.id, head };
  }

  const jobs = async (type: string) =>
    (await database.db.select().from(schema.jobs)).filter((job) => job.type === type);

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async () => 'x' });
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-review-'));
    const templateDir = join(dir, 'template');
    await mkdir(join(templateDir, 'app'), { recursive: true });
    await writeFile(join(templateDir, 'app', 'page.tsx'), 'export default () => null;\n');
    paths = { gitRoot: join(dir, 'git'), workspacesRoot: join(dir, 'workspaces') };
    await initSiteRepo({ gitRoot: paths.gitRoot, templateDir });
  });

  afterAll(async () => {
    await database?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('approves a ready changeset: review, numbered release, releasing status and job', async () => {
    const { id, head } = await readyChangeset();
    const result = await approveChangeset(database.db, { changesetId: id, reviewerUid: ROOT_UID });
    expect(result.releaseNumber).toBe(0);
    expect(result.changeset.status).toBe('releasing');

    const [release] = await database.db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.id, result.releaseId));
    expect(release).toMatchObject({
      status: 'pending',
      commit: head,
      changesetIds: [id],
      approvedBy: ROOT_UID,
    });
    const reviews = await database.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.changesetId, id));
    expect(reviews.map((r) => r.decision)).toEqual(['approved']);
    expect((await jobs(RELEASE_JOB)).map((j) => j.payload)).toContainEqual({
      releaseId: result.releaseId,
    });
    const audit = await database.db.select().from(schema.auditLog);
    expect(audit.map((a) => a.action)).toContain('release.approve');

    // The next release gets the next number.
    const second = await readyChangeset();
    expect(
      (await approveChangeset(database.db, { changesetId: second.id, reviewerUid: ROOT_UID }))
        .releaseNumber,
    ).toBe(1);
  });

  it('refuses to approve a changeset that is not ready, or twice', async () => {
    const { id } = await readyChangeset({ status: 'checks_failed' });
    await expect(
      approveChangeset(database.db, { changesetId: id, reviewerUid: ROOT_UID }),
    ).rejects.toThrow(/controlli/);
    const ready = await readyChangeset();
    await approveChangeset(database.db, { changesetId: ready.id, reviewerUid: ROOT_UID });
    await expect(
      approveChangeset(database.db, { changesetId: ready.id, reviewerUid: ROOT_UID }),
    ).rejects.toThrow(/releasing/);
  });

  it('asks for an explicit confirmation of a destructive migration', async () => {
    const { id } = await readyChangeset({ destructiveMigration: true });
    await expect(
      approveChangeset(database.db, { changesetId: id, reviewerUid: ROOT_UID }),
    ).rejects.toThrow(/migrazione distruttiva/);
    const result = await approveChangeset(database.db, {
      changesetId: id,
      reviewerUid: ROOT_UID,
      confirmDestructive: true,
    });
    expect(result.changeset.status).toBe('releasing');
  });

  it('rejects with a comment: back to draft and a change request for the agent', async () => {
    const { id } = await readyChangeset({ autofixAttempts: 3 });
    await expect(
      rejectChangeset(database.db, { changesetId: id, reviewerUid: ROOT_UID, comment: '  ' }),
    ).rejects.toThrow(/commento/);

    const result = await rejectChangeset(database.db, {
      changesetId: id,
      reviewerUid: ROOT_UID,
      comment: 'Manca il testo alternativo.',
    });
    expect(result.changeset).toMatchObject({ status: 'draft', autofixAttempts: 0 });
    const [review] = await database.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, result.reviewId));
    expect(review).toMatchObject({ decision: 'rejected', comment: 'Manca il testo alternativo.' });
    expect((await jobs(REVISE_JOB)).map((j) => j.payload)).toContainEqual({
      changesetId: id,
      reviewId: result.reviewId,
    });
  });
});
