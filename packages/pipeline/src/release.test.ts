import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_UID, schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createChangeset, recordWork, workspacePath } from './changesets.ts';
import { runGit } from './git.ts';
import {
  createHealthCheck,
  pgDumpTables,
  readCurrentRelease,
  ReleaseBusyError,
  runRelease,
  switchCurrentRelease,
  type ReleaseOptions,
} from './release.ts';
import { approveChangeset } from './review.ts';
import { bareRepoPath, initSiteRepo, type SiteRepoPaths } from './site-repo.ts';

describe('createHealthCheck', () => {
  const ok = (status: number) => (async () => new Response(null, { status })) as typeof fetch;

  it('passes when the site answers', async () => {
    await createHealthCheck({ url: 'http://x/', settleMs: 0, fetch: ok(200) })();
  });

  it('retries and then names the last problem', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await createHealthCheck({ url: 'http://x/', settleMs: 0, intervalMs: 1, fetch: flaky })();
    expect(calls).toBe(3);

    await expect(
      createHealthCheck({
        url: 'http://x/',
        settleMs: 0,
        intervalMs: 1,
        attempts: 2,
        fetch: ok(500),
      })(),
    ).rejects.toThrow(/risposta 500/);
  });
});

describe('the current release pointer', () => {
  it('switches atomically and can be removed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-cms-ptr-'));
    try {
      expect(await readCurrentRelease(dir)).toBeNull();
      await switchCurrentRelease(dir, 'one');
      await switchCurrentRelease(dir, 'two');
      expect(await readCurrentRelease(dir)).toBe('two');
      await switchCurrentRelease(dir, null);
      expect(await readCurrentRelease(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const hasPgDump = (() => {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!testDatabaseUrl)('runRelease', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let admin: postgres.Sql;
  let dir: string;
  let paths: SiteRepoPaths;
  let prodName: string;
  let prodUrl: string;
  let releasesRoot: string;
  let backupsRoot: string;
  let built: string[];
  let dumps: Array<{ tables: readonly string[]; file: string }>;

  const urlFor = (name: string) => {
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${name}`;
    return url.toString();
  };
  const bare = () => bareRepoPath(paths.gitRoot);
  const rev = async (ref: string) => (await runGit(['rev-parse', ref], { cwd: bare() })).trim();

  const options = (patch: Partial<ReleaseOptions> = {}): ReleaseOptions => ({
    site: paths,
    releasesRoot,
    backupsRoot,
    prodOwnerUrl: () => prodUrl,
    builder: {
      async buildRelease(request) {
        built.push(request.releaseId);
        const artifact = join(releasesRoot, request.releaseId);
        await mkdir(artifact, { recursive: true });
        await writeFile(join(artifact, 'SERVER'), 'server.js\n');
        return { releaseId: request.releaseId, commit: request.commit, server: 'server.js' };
      },
    },
    dump: async ({ tables, file }) => {
      dumps.push({ tables, file });
      await mkdir(backupsRoot, { recursive: true });
      await writeFile(file, 'dump');
      return true;
    },
    healthCheck: async () => undefined,
    rerunChecks: async (id) => {
      await database.db
        .update(schema.changesets)
        .set({ status: 'ready' })
        .where(eq(schema.changesets.id, id));
      return 'ready';
    },
    ...patch,
  });

  /** A ready, approved changeset with the given files committed on its branch. */
  async function approved(files: Record<string, string>) {
    const cs = await createChangeset(database.db, { title: 'Prova', authorUid: ROOT_UID }, paths);
    const cwd = workspacePath(paths, cs.id);
    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(cwd, file, '..'), { recursive: true });
      await writeFile(join(cwd, file), content);
    }
    await runGit(['add', '--all'], { cwd });
    await runGit(['commit', '--quiet', '-m', 'work'], { cwd });
    await recordWork(database.db, cs.id, paths);
    await database.db
      .update(schema.changesets)
      .set({ status: 'ready' })
      .where(eq(schema.changesets.id, cs.id));
    const result = await approveChangeset(database.db, {
      changesetId: cs.id,
      reviewerUid: ROOT_UID,
      confirmDestructive: true,
    });
    return { id: cs.id, ...result };
  }

  const releaseRow = async (id: string) =>
    (await database.db.select().from(schema.releases).where(eq(schema.releases.id, id)))[0]!;
  const changesetRow = async (id: string) =>
    (await database.db.select().from(schema.changesets).where(eq(schema.changesets.id, id)))[0]!;
  const prodTables = async () => {
    const sql = postgres(prodUrl, { max: 1 });
    const rows = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    await sql.end();
    return rows.map((r) => r.table_name).sort();
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async () => 'x' });
    admin = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    prodName = `prod_${randomBytes(6).toString('hex')}`;
    await admin.unsafe(`CREATE DATABASE ${prodName}`);
    prodUrl = urlFor(prodName);

    dir = await mkdtemp(join(tmpdir(), 'ai-cms-release-'));
    const templateDir = join(dir, 'template');
    await mkdir(join(templateDir, 'app'), { recursive: true });
    await writeFile(join(templateDir, 'app', 'page.tsx'), 'export default () => null;\n');
    await writeFile(join(templateDir, 'shared.ts'), 'export const value = 0;\n');
    paths = { gitRoot: join(dir, 'git'), workspacesRoot: join(dir, 'workspaces') };
    await initSiteRepo({ gitRoot: paths.gitRoot, templateDir });
    releasesRoot = join(dir, 'releases');
    backupsRoot = join(dir, 'backups');
  });

  beforeEach(() => {
    built = [];
    dumps = [];
  });

  afterAll(async () => {
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${prodName} WITH (FORCE)`);
    await admin?.end();
    await database?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('releases: builds, migrates, switches, merges into main and tags', async () => {
    const cs = await approved({
      'app/catalogo/page.tsx': 'export default () => 1;\n',
      'db/migrations/0001_prodotti.sql':
        'CREATE TABLE prodotti (id serial PRIMARY KEY, nome text);\n',
    });
    const outcome = await runRelease(database.db, cs.releaseId, options());
    expect(outcome).toMatchObject({ status: 'released', number: 0, tag: 'release-0' });

    const release = await releaseRow(cs.releaseId);
    expect(release).toMatchObject({ status: 'released', error: null });
    expect(release.finishedAt).not.toBeNull();
    expect(release.artifactPath).toBe(join(releasesRoot, cs.releaseId));
    expect((await changesetRow(cs.id)).status).toBe('released');

    expect(built).toEqual([cs.releaseId]);
    expect(await prodTables()).toContain('prodotti');
    expect(await readCurrentRelease(releasesRoot)).toBe(cs.releaseId);
    const head = (await changesetRow(cs.id)).headCommit!;
    expect(await rev('main')).toBe(head);
    expect(await rev('release-0')).toBe(head);
    // Staging followed main, so the next changeset starts from the released code.
    expect(await rev('staging')).toBe(head);
    // A new table holds nothing to lose: no dump.
    expect(dumps).toEqual([]);

    const audit = await database.db.select().from(schema.auditLog);
    expect(audit.filter((a) => a.action === 'release.deploy' && a.outcome === 'ok')).toHaveLength(
      1,
    );
  });

  it('skips a release that already ran', async () => {
    const cs = await approved({ 'app/a.tsx': 'export default 1;\n' });
    await runRelease(database.db, cs.releaseId, options());
    expect(await runRelease(database.db, cs.releaseId, options())).toMatchObject({
      status: 'skipped',
    });
  });

  it('backs up the tables a migration touches before applying it', async () => {
    const cs = await approved({
      'db/migrations/0002_prezzo.sql': 'ALTER TABLE prodotti ADD COLUMN prezzo integer;\n',
    });
    // The site keeps the migration of the previous release: they are applied in name order.
    const migrations = await runGit(['ls-tree', '--name-only', '-r', 'main', 'db/migrations'], {
      cwd: bare(),
    });
    expect(migrations).toContain('0001_prodotti.sql');
    const outcome = await runRelease(database.db, cs.releaseId, options());
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'released' });
    expect(dumps).toHaveLength(1);
    expect(dumps[0]!.tables).toEqual(['prodotti']);
    expect(dumps[0]!.file).toBe(
      join(backupsRoot, `release-${String(cs.releaseNumber)}-${cs.releaseId}.dump`),
    );
    expect((await releaseRow(cs.releaseId)).backupPath).toBe(dumps[0]!.file);
    const sql = postgres(prodUrl, { max: 1 });
    const columns = await sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'prodotti'`;
    await sql.end();
    expect(columns.map((c) => c.column_name)).toContain('prezzo');
  });

  it('does not touch production when the backup fails', async () => {
    const cs = await approved({
      'db/migrations/0003_extra.sql': 'ALTER TABLE prodotti ADD COLUMN extra text;\n',
    });
    const before = await rev('main');
    const outcome = await runRelease(
      database.db,
      cs.releaseId,
      options({
        dump: async () => {
          throw new Error('pg_dump non riuscito: disco pieno');
        },
      }),
    );
    expect(outcome).toMatchObject({ status: 'failed', step: 'backup' });
    expect((await releaseRow(cs.releaseId)).status).toBe('failed');
    expect((await changesetRow(cs.id)).status).toBe('release_failed');
    expect(await rev('main')).toBe(before);
    const sql = postgres(prodUrl, { max: 1 });
    const columns = await sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'prodotti'`;
    await sql.end();
    expect(columns.map((c) => c.column_name)).not.toContain('extra');
  });

  it('restores the previous artifact and leaves main alone when the health check fails', async () => {
    const before = await rev('main');
    const previous = await readCurrentRelease(releasesRoot);
    expect(previous).not.toBeNull();
    const cs = await approved({ 'app/nuova/page.tsx': 'export default 2;\n' });
    const restarts: Array<string | null> = [];
    const outcome = await runRelease(
      database.db,
      cs.releaseId,
      options({
        restart: async () => {
          restarts.push(await readCurrentRelease(releasesRoot));
        },
        healthCheck: async () => {
          throw new Error('Il sito di produzione non risponde');
        },
      }),
    );
    expect(outcome).toMatchObject({ status: 'failed', step: 'health' });
    expect(await readCurrentRelease(releasesRoot)).toBe(previous);
    // Restarted on the new release, then again on the old one.
    expect(restarts).toEqual([cs.releaseId, previous]);
    expect(await rev('main')).toBe(before);
    expect((await changesetRow(cs.id)).status).toBe('release_failed');
    const failure = (await database.db.select().from(schema.auditLog)).find(
      (a) => a.action === 'release.deploy' && a.outcome === 'error',
    );
    expect(failure).toBeDefined();
  });

  it('rebases on main when it moved and runs the checks again', async () => {
    const first = await approved({ 'app/uno.tsx': 'export default 1;\n' });
    const second = await approved({ 'app/due.tsx': 'export default 2;\n' });
    expect((await runRelease(database.db, first.releaseId, options())).status).toBe('released');

    let rechecked: string[] = [];
    const outcome = await runRelease(
      database.db,
      second.releaseId,
      options({
        rerunChecks: async (id) => {
          rechecked.push(id);
          expect((await changesetRow(id)).status).toBe('checking');
          await database.db
            .update(schema.changesets)
            .set({ status: 'ready' })
            .where(eq(schema.changesets.id, id));
          return 'ready';
        },
      }),
    );
    expect(outcome.status).toBe('released');
    expect(rechecked).toEqual([second.id]);
    const head = (await changesetRow(second.id)).headCommit!;
    expect(head).not.toBe((await releaseRow(first.releaseId)).commit);
    // main holds both: the rebased commit sits on top of the first release.
    expect(await rev('main')).toBe(head);
    expect(
      await runGit(
        ['merge-base', '--is-ancestor', (await releaseRow(first.releaseId)).commit!, head],
        { cwd: bare() },
      ).then(() => true),
    ).toBe(true);
    expect((await changesetRow(second.id)).status).toBe('released');
    rechecked = [];
  });

  it('fails when the rebase conflicts with main', async () => {
    const first = await approved({ 'shared.ts': 'export const value = 1;\n' });
    const second = await approved({ 'shared.ts': 'export const value = 2;\n' });
    expect((await runRelease(database.db, first.releaseId, options())).status).toBe('released');
    const main = await rev('main');
    const outcome = await runRelease(database.db, second.releaseId, options());
    expect(outcome).toMatchObject({ status: 'failed', step: 'rebase' });
    expect(await rev('main')).toBe(main);
    expect(built).toEqual([first.releaseId]);
    expect((await changesetRow(second.id)).status).toBe('release_failed');
    // The clone is left clean, ready for the agent to resolve the conflict.
    const status = await runGit(['status', '--porcelain'], {
      cwd: workspacePath(paths, second.id),
    });
    expect(status.trim()).toBe('');
  });

  it('does not release when the checks fail after the rebase', async () => {
    const first = await approved({ 'app/tre.tsx': 'export default 3;\n' });
    const second = await approved({ 'app/quattro.tsx': 'export default 4;\n' });
    await runRelease(database.db, first.releaseId, options());
    const outcome = await runRelease(
      database.db,
      second.releaseId,
      options({
        rerunChecks: async (id) => {
          await database.db
            .update(schema.changesets)
            .set({ status: 'checks_failed' })
            .where(eq(schema.changesets.id, id));
          return 'checks_failed';
        },
      }),
    );
    expect(outcome).toMatchObject({ status: 'failed', step: 'checks' });
    expect((await changesetRow(second.id)).status).toBe('checks_failed');
    expect(built).toEqual([first.releaseId]);
  });

  it('waits for its turn while another release holds the lock', async () => {
    const cs = await approved({ 'app/cinque.tsx': 'export default 5;\n' });
    // The advisory lock is per database: the other release holds it on the platform one.
    const other = postgres(database.url, { max: 1 });
    try {
      await other.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('release-run'))`;
        await expect(runRelease(database.db, cs.releaseId, options())).rejects.toBeInstanceOf(
          ReleaseBusyError,
        );
      });
      // Once free, the same job runs.
      expect((await runRelease(database.db, cs.releaseId, options())).status).toBe('released');
    } finally {
      await other.end();
    }
  });

  it.skipIf(!hasPgDump)('dumps only the tables that exist with pg_dump', async () => {
    const file = join(backupsRoot, 'real.dump');
    await mkdir(backupsRoot, { recursive: true });
    expect(
      await pgDumpTables({ databaseUrl: prodUrl, tables: ['prodotti', 'non_esiste'], file }),
    ).toBe(true);
    expect((await readFile(file)).length).toBeGreaterThan(0);
    expect(
      await pgDumpTables({
        databaseUrl: prodUrl,
        tables: ['non_esiste'],
        file: join(backupsRoot, 'none.dump'),
      }),
    ).toBe(false);
    await expect(access(join(backupsRoot, 'none.dump'))).rejects.toThrow();
  });
});
