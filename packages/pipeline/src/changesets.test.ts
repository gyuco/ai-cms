import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_UID, schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canTransition,
  closeChangeset,
  createChangeset,
  findConflicts,
  recordWork,
  setChangesetStatus,
  workspacePath,
  type ChangesetStatus,
} from './changesets.ts';
import { runGit } from './git.ts';
import { bareRepoPath, initSiteRepo, type SiteRepoPaths } from './site-repo.ts';

describe('canTransition', () => {
  it.each<[ChangesetStatus, ChangesetStatus]>([
    ['draft', 'checking'],
    ['checking', 'checks_failed'],
    ['checks_failed', 'checking'],
    ['checking', 'ready'],
    ['ready', 'releasing'],
    ['ready', 'draft'],
    ['releasing', 'released'],
    ['releasing', 'release_failed'],
    ['released', 'rolled_back'],
    ['draft', 'closed'],
  ])('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each<[ChangesetStatus, ChangesetStatus]>([
    ['draft', 'ready'],
    ['draft', 'released'],
    ['checking', 'releasing'],
    ['checks_failed', 'ready'],
    ['ready', 'released'],
    ['released', 'draft'],
    ['releasing', 'closed'],
    ['closed', 'draft'],
    ['rolled_back', 'released'],
  ])('refuses %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});

describe.skipIf(!testDatabaseUrl)('changeset lifecycle', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let dir: string;
  let paths: SiteRepoPaths;

  async function commitFile(changesetId: string, file: string, content: string) {
    const cwd = workspacePath(paths, changesetId);
    await mkdir(join(cwd, file, '..'), { recursive: true });
    await writeFile(join(cwd, file), content);
    await runGit(['add', '--all'], { cwd });
    await runGit(['commit', '--quiet', '-m', `edit ${file}`], { cwd });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async () => 'x' });
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-cs-'));
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

  it('creates a draft with a working clone on cs/<id> from staging', async () => {
    const cs = await createChangeset(
      database.db,
      { title: 'Catalogo', authorUid: ROOT_UID },
      paths,
    );
    const staging = await runGit(['rev-parse', 'staging'], { cwd: bareRepoPath(paths.gitRoot) });
    expect(cs).toMatchObject({
      status: 'draft',
      branch: `cs/${cs.id}`,
      baseCommit: staging.trim(),
    });
    const branch = await runGit(['branch', '--show-current'], {
      cwd: workspacePath(paths, cs.id),
    });
    expect(branch.trim()).toBe(`cs/${cs.id}`);

    const audit = await database.db.select().from(schema.auditLog);
    expect(audit.map((a) => a.action)).toContain('changeset.create');
  });

  it('records work: pushes the branch and maps touched files to tree paths', async () => {
    const cs = await createChangeset(database.db, { title: 'Pagine', authorUid: ROOT_UID }, paths);
    await commitFile(cs.id, 'app/(dynamic)/catalogo/page.tsx', 'export default 1;\n');
    await commitFile(cs.id, 'lib/prezzi.ts', 'export const x = 1;\n');

    const result = await recordWork(database.db, cs.id, paths);
    expect(result.changedFiles.sort()).toEqual([
      'app/(dynamic)/catalogo/page.tsx',
      'lib/prezzi.ts',
    ]);
    expect(result.touchedPaths).toEqual(['code.lib', 'site.pages.catalogo']);

    const bareHead = await runGit(['rev-parse', `cs/${cs.id}`], {
      cwd: bareRepoPath(paths.gitRoot),
    });
    const [row] = await database.db
      .select()
      .from(schema.changesets)
      .where(eq(schema.changesets.id, cs.id));
    expect(row?.headCommit).toBe(bareHead.trim());
    expect(row?.touchedPaths.sort()).toEqual(['code.lib', 'site.pages.catalogo']);
  });

  it('refuses to record work outside draft and checks_failed', async () => {
    const cs = await createChangeset(database.db, { title: 'Stato', authorUid: ROOT_UID }, paths);
    await setChangesetStatus(database.db, cs.id, 'checking');
    await expect(recordWork(database.db, cs.id, paths)).rejects.toThrow(/checking/);
  });

  it('validates status transitions', async () => {
    const cs = await createChangeset(database.db, { title: 'Flusso', authorUid: ROOT_UID }, paths);
    await expect(setChangesetStatus(database.db, cs.id, 'released')).rejects.toThrow(
      /non consentita/,
    );
    await setChangesetStatus(database.db, cs.id, 'checking');
    await setChangesetStatus(database.db, cs.id, 'checks_failed');
    await setChangesetStatus(database.db, cs.id, 'checking');
    const ready = await setChangesetStatus(database.db, cs.id, 'ready', { actorUid: 1 });
    expect(ready.status).toBe('ready');
    const audit = await database.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'changeset.status'));
    expect(audit.at(-1)).toMatchObject({
      actorUid: 1,
      details: expect.objectContaining({ changesetId: cs.id, from: 'checking', to: 'ready' }),
    });
  });

  it('finds open changesets touching overlapping paths', async () => {
    const a = await createChangeset(database.db, { title: 'A', authorUid: ROOT_UID }, paths);
    const b = await createChangeset(database.db, { title: 'B', authorUid: ROOT_UID }, paths);
    const c = await createChangeset(database.db, { title: 'C', authorUid: ROOT_UID }, paths);
    await commitFile(a.id, 'api/ordini.ts', 'export {};\n');
    await commitFile(b.id, 'package.json', '{}\n'); // → code, an ancestor of code.api
    await commitFile(c.id, 'components/Card.tsx', 'export {};\n');
    for (const cs of [a, b, c]) await recordWork(database.db, cs.id, paths);

    const conflicts = await findConflicts(database.db, a.id);
    expect(conflicts.map((x) => x.changesetId)).toContain(b.id);
    expect(conflicts.map((x) => x.changesetId)).not.toContain(c.id);
    expect(conflicts.find((x) => x.changesetId === b.id)?.paths).toEqual(['code']);

    await closeChangeset(database.db, b.id, paths);
    expect((await findConflicts(database.db, a.id)).map((x) => x.changesetId)).not.toContain(b.id);
  });

  it('closes a changeset and removes its working clone', async () => {
    const cs = await createChangeset(database.db, { title: 'Chiudi', authorUid: ROOT_UID }, paths);
    const closed = await closeChangeset(database.db, cs.id, paths);
    expect(closed.status).toBe('closed');
    await expect(access(workspacePath(paths, cs.id))).rejects.toThrow();
    // Closing twice is harmless.
    expect((await closeChangeset(database.db, cs.id, paths)).status).toBe('closed');
  });

  it('refuses to close while checks are running', async () => {
    const cs = await createChangeset(
      database.db,
      { title: 'Occupato', authorUid: ROOT_UID },
      paths,
    );
    await setChangesetStatus(database.db, cs.id, 'checking');
    await expect(closeChangeset(database.db, cs.id, paths)).rejects.toThrow(/non consentita/);
    await access(workspacePath(paths, cs.id));
  });

  it('does not run hooks configured in the working clone', async () => {
    const cs = await createChangeset(database.db, { title: 'Hook', authorUid: ROOT_UID }, paths);
    const cwd = workspacePath(paths, cs.id);
    const marker = join(dir, 'pwned');
    await mkdir(join(cwd, 'evil-hooks'));
    await writeFile(join(cwd, 'evil-hooks', 'pre-push'), `#!/bin/sh\ntouch ${marker}\n`, {
      mode: 0o755,
    });
    await runGit(['config', 'core.hooksPath', join(cwd, 'evil-hooks')], { cwd });
    await commitFile(cs.id, 'lib/a.ts', 'export {};\n');
    await recordWork(database.db, cs.id, paths);
    await expect(access(marker)).rejects.toThrow();
  });
});
