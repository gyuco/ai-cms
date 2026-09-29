import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_UID, schema, seed, type Database } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import {
  changesetDatabaseName,
  runGit,
  workspacePath,
  type BuilderClient,
  type BuilderRunRequest,
  type Job,
} from '@ai-cms/pipeline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandlers, startupJobs } from './handlers.ts';

async function makeTemplate(dir: string) {
  const templateDir = join(dir, 'template');
  await mkdir(join(templateDir, 'app'), { recursive: true });
  await writeFile(join(templateDir, 'package.json'), '{}\n');
  return templateDir;
}

describe('site.init handler', () => {
  let dir: string | undefined;

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('runs at startup and creates site.git', async () => {
    expect(startupJobs).toContain('site.init');
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-worker-'));
    const handlers = createHandlers({} as Database, {
      site: { gitRoot: join(dir, 'git'), workspacesRoot: join(dir, 'ws') },
      templateDir: await makeTemplate(dir),
    });
    const result = await handlers['site.init']!({}, {} as Job);
    expect(result).toMatchObject({ created: true });
  });
});

describe('release and revision handlers', () => {
  const handlers = createHandlers({} as Database, {
    site: { gitRoot: '/nonexistent/git', workspacesRoot: '/nonexistent/ws' },
  });

  it('are registered and check their payload', async () => {
    await expect(handlers['release.run']!({}, {} as Job)).rejects.toThrow(/releaseId/);
    await expect(handlers['changeset.revise']!({}, {} as Job)).rejects.toThrow(/changesetId/);
    await expect(
      handlers['changeset.revise']!(
        { changesetId: '0b5c7a4e-9d1f-4c3a-8e2b-1f2a3b4c5d6e' },
        {} as Job,
      ),
    ).rejects.toThrow(/reviewId/);
  });
});

describe.skipIf(!testDatabaseUrl)('changeset handlers', () => {
  const stagingTemplate = `tpl_${randomBytes(6).toString('hex')}`;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let dir: string;
  let handlers: ReturnType<typeof createHandlers>;
  const site = () => ({ gitRoot: join(dir, 'git'), workspacesRoot: join(dir, 'ws') });
  const run = (type: string, payload: unknown) => handlers[type]!(payload, {} as Job);
  const deleted: string[] = [];
  const builder: BuilderClient = {
    async buildRelease() {
      throw new Error('non usato');
    },
    async startRun(request: BuilderRunRequest) {
      return {
        id: 'r',
        changesetId: request.changesetId,
        commit: request.commit,
        status: 'finished',
        createdAt: '',
        finishedAt: '',
        checks: request.checks.map((name) => ({ name, status: 'passed', output: null })),
      };
    },
    getRun: async () => {
      throw new Error('not polled');
    },
    deleteArtifacts: async (id) => void deleted.push(id),
  };
  const urlFor = (name: string) => {
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${name}`;
    return url.toString();
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async () => 'x' });
    await database.sql.unsafe(`CREATE DATABASE ${stagingTemplate}`);
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-worker-cs-'));
    handlers = createHandlers(database.db, {
      site: site(),
      templateDir: await makeTemplate(dir),
      stagingAdminUrl: () => testDatabaseUrl!,
      stagingTemplate,
      builder,
      stagingDatabaseUrl: (_role, name) => urlFor(name),
      checks: { publishedPages: async () => ['/'] },
    });
    await run('site.init', {});
  });

  afterAll(async () => {
    await database?.sql.unsafe(`DROP DATABASE IF EXISTS ${stagingTemplate} WITH (FORCE)`);
    await database?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('creates, records and closes a changeset with its database', async () => {
    const created = (await run('changeset.create', {
      title: 'Catalogo',
      authorUid: ROOT_UID,
    })) as { changesetId: string; database: string };
    const id = created.changesetId;
    expect(created.database).toBe(changesetDatabaseName(id));

    const cwd = workspacePath(site(), id);
    await mkdir(join(cwd, 'api'));
    await writeFile(join(cwd, 'api', 'ordini.ts'), 'export {};\n');
    await runGit(['add', '--all'], { cwd });
    await runGit(['commit', '--quiet', '-m', 'ordini'], { cwd });
    expect(await run('changeset.record', { changesetId: id })).toMatchObject({
      touchedPaths: ['code.api'],
    });
    expect(await run('changeset.check', { changesetId: id })).toMatchObject({
      status: 'ready',
      destructiveMigration: false,
      checks: { permissions: 'passed', migration: 'skipped', build: 'passed' },
    });

    expect(await run('changeset.close', { changesetId: id })).toEqual({ status: 'closed' });
    expect(deleted).toEqual([id]);
    await expect(access(cwd)).rejects.toThrow();
    const dbs = await database.sql`SELECT 1 FROM pg_database WHERE datname = ${created.database}`;
    expect(dbs).toHaveLength(0);
    const rows = await database.db.select().from(schema.changesets);
    expect(rows.find((r) => r.id === id)?.status).toBe('closed');
  });

  it('rejects payloads without a changeset id', async () => {
    await expect(run('changeset.record', {})).rejects.toThrow(/changesetId/);
  });
});
