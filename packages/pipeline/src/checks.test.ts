import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_UID, schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { asc, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuilderClient } from './builder-client.ts';
import type { BuilderRun, BuilderRunRequest, CheckResult } from './builder-protocol.ts';
import { createChangesetDatabase, changesetDatabaseName } from './changeset-db.ts';
import {
  pageUrlForTreePath,
  pageUrlsForFiles,
  permissionsCheck,
  runChangesetChecks,
} from './checks.ts';
import { createChangeset, workspacePath } from './changesets.ts';
import { runGit } from './git.ts';
import { initSiteRepo, type SiteRepoPaths } from './site-repo.ts';

const root = { uid: ROOT_UID, username: 'root', status: 'active' as const };

describe('permissionsCheck', () => {
  it('passes when every touched path is allowed to the developer agent', () => {
    const result = permissionsCheck(root, ['code.api', 'site.pages.blog']);
    expect(result.status).toBe('passed');
    expect(result.output).toContain('/code/api');
  });

  it('fails on paths outside the developer agent profile', () => {
    const result = permissionsCheck(root, ['code.lib', 'system.secrets.ai']);
    expect(result.status).toBe('failed');
    expect(result.output).toContain('/system/secrets/ai');
    expect(result.output).not.toContain('/code/lib:');
  });

  it('fails for an author who is no longer active', () => {
    expect(permissionsCheck({ ...root, status: 'suspended' }, ['code']).status).toBe('failed');
  });

  it('passes an empty changeset', () => {
    expect(permissionsCheck(root, []).status).toBe('passed');
  });
});

describe('page URLs', () => {
  it('maps App Router page files to URL paths', () => {
    expect(
      pageUrlsForFiles([
        'app/page.tsx',
        'app/(dynamic)/prenota/page.tsx',
        'app/(dynamic)/negozio/carrello/page.tsx',
        'app/(dynamic)/prodotti/[id]/page.tsx',
        'app/(dynamic)/prenota/form.tsx',
        'components/Header.tsx',
      ]),
    ).toEqual(['/', '/negozio/carrello', '/prenota']);
  });

  it('maps page nodes to URL paths', () => {
    expect(pageUrlForTreePath('site.pages.index')).toBe('/');
    expect(pageUrlForTreePath('site.pages.blog.index')).toBe('/blog');
    expect(pageUrlForTreePath('site.pages.chi-siamo')).toBe('/chi-siamo');
    expect(pageUrlForTreePath('site.layouts.main')).toBeNull();
  });
});

/** A builder that answers every requested check with the given statuses, in two polls. */
function fakeBuilder(
  statuses: Partial<Record<string, CheckResult['status']>> = {},
): BuilderClient & { requests: BuilderRunRequest[] } {
  const requests: BuilderRunRequest[] = [];
  let polls = 0;
  let request: BuilderRunRequest;
  const run = (finished: boolean): BuilderRun => ({
    id: 'run-1',
    changesetId: request.changesetId,
    commit: request.commit,
    status: finished ? 'finished' : 'running',
    createdAt: new Date().toISOString(),
    finishedAt: finished ? new Date().toISOString() : null,
    checks: request.checks.map((name, i) => ({
      name,
      status: finished ? (statuses[name] ?? 'passed') : i === 0 ? 'running' : 'queued',
      output: finished ? `output di ${name}` : null,
    })),
  });
  return {
    requests,
    async startRun(r) {
      request = r;
      requests.push(r);
      polls = 0;
      return run(false);
    },
    async getRun() {
      polls++;
      return run(polls >= 2);
    },
    async deleteArtifacts() {},
  };
}

describe.skipIf(!testDatabaseUrl)('runChangesetChecks', () => {
  const template = `tpl_${randomBytes(6).toString('hex')}`;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let dir: string;
  let paths: SiteRepoPaths;
  const urlFor = (name: string) => {
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${name}`;
    return url.toString();
  };

  async function commitFiles(changesetId: string, files: Record<string, string>) {
    const cwd = workspacePath(paths, changesetId);
    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(cwd, file, '..'), { recursive: true });
      await writeFile(join(cwd, file), content);
    }
    await runGit(['add', '--all'], { cwd });
    await runGit(['commit', '--quiet', '-m', 'edit'], { cwd });
  }

  async function newChangeset() {
    const changeset = await createChangeset(
      database.db,
      { title: 'Prenotazioni', authorUid: ROOT_UID },
      paths,
    );
    await createChangesetDatabase(testDatabaseUrl!, changeset.id, { template });
    return changeset.id;
  }

  const options = (builder: BuilderClient) => ({
    site: paths,
    builder,
    appDatabaseUrl: urlFor,
    ownerDatabaseUrl: urlFor,
    stagingAdminUrl: () => testDatabaseUrl!,
    stagingTemplate: template,
    publishedPages: async () => ['/', '/contatti'],
    pollIntervalMs: 1,
  });

  const checkRows = (changesetId: string) =>
    database.db
      .select()
      .from(schema.checkRuns)
      .where(eq(schema.checkRuns.changesetId, changesetId))
      .orderBy(asc(schema.checkRuns.id));

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async () => 'x' });
    const admin = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${template}`);
    await admin.end();
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-checks-'));
    const templateDir = join(dir, 'template');
    await mkdir(join(templateDir, 'app'), { recursive: true });
    await writeFile(join(templateDir, 'app', 'page.tsx'), 'export default () => null;\n');
    paths = { gitRoot: join(dir, 'git'), workspacesRoot: join(dir, 'workspaces') };
    await initSiteRepo({ gitRoot: paths.gitRoot, templateDir });
  });

  afterAll(async () => {
    const admin = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    const clones = await admin<Array<{ datname: string }>>`
      SELECT datname FROM pg_database WHERE datname LIKE 'app_cs_%'`;
    const ours = await database?.db.select({ id: schema.changesets.id }).from(schema.changesets);
    const mine = new Set(ours?.map((c) => changesetDatabaseName(c.id)));
    for (const { datname } of clones) {
      if (mine.has(datname)) await admin.unsafe(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
    }
    await admin.unsafe(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
    await admin.end();
    await database?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('runs every check and makes the changeset ready', async () => {
    const id = await newChangeset();
    await commitFiles(id, {
      'app/(dynamic)/prenota/page.tsx': 'export default () => null;\n',
      'db/migrations/0000_prenotazioni.sql':
        'CREATE TABLE prenotazioni (id serial PRIMARY KEY, nome text NOT NULL);',
    });
    const builder = fakeBuilder();
    const updates: string[] = [];
    const result = await runChangesetChecks(database.db, id, {
      ...options(builder),
      onUpdate: (r) => updates.push(`${r.name}:${r.status}`),
    });

    expect(result.status).toBe('ready');
    expect(result.destructiveMigration).toBe(false);
    expect(builder.requests[0]).toMatchObject({
      changesetId: id,
      commit: result.commit,
      databaseUrl: urlFor(changesetDatabaseName(id)),
      checks: ['typecheck', 'lint', 'deps', 'unit', 'build', 'e2e', 'html', 'a11y'],
      pages: ['/', '/prenota'],
      publishedPages: ['/', '/contatti'],
    });
    expect(updates.slice(0, 4)).toEqual([
      'permissions:running',
      'permissions:passed',
      'migration:running',
      'migration:passed',
    ]);
    expect(updates).toContain('typecheck:running');

    const rows = await checkRows(id);
    expect(rows.map((r) => [r.checkName, r.status])).toEqual([
      ['permissions', 'passed'],
      ['typecheck', 'passed'],
      ['lint', 'passed'],
      ['deps', 'passed'],
      ['unit', 'passed'],
      ['migration', 'passed'],
      ['build', 'passed'],
      ['e2e', 'passed'],
      ['html', 'passed'],
      ['a11y', 'passed'],
    ]);
    expect(rows.every((r) => r.commit === result.commit && r.finishedAt)).toBe(true);
    expect(rows.find((r) => r.checkName === 'migration')?.output).toContain(
      '0000_prenotazioni.sql',
    );

    const clone = postgres(urlFor(changesetDatabaseName(id)), { max: 1 });
    expect(await clone`SELECT to_regclass('prenotazioni')::text AS t`).toEqual([
      { t: 'prenotazioni' },
    ]);
    await clone.end();

    const [changeset] = await database.db
      .select()
      .from(schema.changesets)
      .where(eq(schema.changesets.id, id));
    expect(changeset?.status).toBe('ready');
    const audit = await database.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'changeset.checks'));
    expect(audit.at(-1)?.details).toMatchObject({ changesetId: id, commit: result.commit });
  });

  it('flags destructive migrations and fails on a failed check, then re-runs', async () => {
    const id = await newChangeset();
    await commitFiles(id, {
      'db/migrations/0000_a.sql': 'CREATE TABLE a (id int, note text);',
      'db/migrations/0001_b.sql': 'ALTER TABLE a DROP COLUMN note;',
    });
    const failing = await runChangesetChecks(
      database.db,
      id,
      options(fakeBuilder({ typecheck: 'failed' })),
    );
    expect(failing.status).toBe('checks_failed');
    expect(failing.destructiveMigration).toBe(true);
    const migration = failing.checks.find((c) => c.name === 'migration');
    expect(migration?.status).toBe('passed');
    expect(migration?.output).toMatch(/migrazione distruttiva[\s\S]*0001_b\.sql/);

    // The agent edits an applied migration: the clone is recreated and replayed.
    await commitFiles(id, { 'db/migrations/0001_b.sql': 'ALTER TABLE a ADD COLUMN extra text;' });
    const fixed = await runChangesetChecks(database.db, id, options(fakeBuilder()));
    expect(fixed.status).toBe('ready');
    expect(fixed.destructiveMigration).toBe(false);
    expect(fixed.checks.find((c) => c.name === 'migration')?.output).toMatch(/ricreato/);
    expect((await checkRows(id)).length).toBe(20);
  });

  it('stops after a permissions failure and when the builder is unreachable', async () => {
    const id = await newChangeset();
    await commitFiles(id, { 'api/prenota.ts': 'export {};\n' });
    await database.db
      .update(schema.users)
      .set({ status: 'suspended' })
      .where(eq(schema.users.uid, ROOT_UID));
    try {
      const builder = fakeBuilder();
      const result = await runChangesetChecks(database.db, id, options(builder));
      expect(result.status).toBe('checks_failed');
      expect(builder.requests).toHaveLength(0);
      expect(result.checks.filter((c) => c.status === 'skipped')).toHaveLength(9);
    } finally {
      await database.db
        .update(schema.users)
        .set({ status: 'active' })
        .where(eq(schema.users.uid, ROOT_UID));
    }

    await commitFiles(id, { 'api/prenota.ts': 'export const x = 1;\n' });
    const down: BuilderClient = {
      startRun: async () => {
        throw new Error('connessione rifiutata');
      },
      getRun: async () => {
        throw new Error('unreachable');
      },
      deleteArtifacts: async () => {},
    };
    const result = await runChangesetChecks(database.db, id, options(down));
    expect(result.status).toBe('checks_failed');
    expect(result.checks.find((c) => c.name === 'build')).toMatchObject({
      status: 'failed',
      output: expect.stringContaining('connessione rifiutata'),
    });
    expect(result.checks.find((c) => c.name === 'migration')?.status).toBe('skipped');
  });
});
