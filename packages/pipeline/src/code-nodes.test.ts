import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT_UID, schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listRepoFiles, loadManifest, syncCodeNodes } from './code-nodes.ts';
import { runGit } from './git.ts';
import { bareRepoPath, initSiteRepo, type SiteRepoPaths } from './site-repo.ts';

const MANIFEST = {
  version: 1,
  rules: [
    { tree: '/site/pages/{path}/page.tsx', repo: 'app/(dynamic)/{path}/page.tsx' },
    { tree: '/site/components/{path}', repo: 'components/{path}' },
    { tree: '/code/api/{path}', repo: 'api/{path}' },
    { tree: '/code/lib/{path}', repo: 'lib/{path}' },
    { tree: '/data/collections/{name}/schema', repo: 'db/schema/{name}.ts' },
  ],
  files: [],
};

describe.skipIf(!testDatabaseUrl)('code node sync', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let dir: string;
  let paths: SiteRepoPaths;

  async function commitToBranch(branch: string, mutate: (work: string) => Promise<void>) {
    const work = await mkdtemp(join(tmpdir(), 'ai-cms-cn-'));
    const bare = bareRepoPath(paths.gitRoot);
    try {
      await runGit(['clone', '--quiet', '--branch', branch, '--', bare, work]);
      await mutate(work);
      await runGit(['add', '--all'], { cwd: work });
      await runGit(['commit', '--quiet', '-m', 'update'], { cwd: work });
      await runGit(['push', '--quiet', bare, `HEAD:refs/heads/${branch}`], {
        cwd: work,
        env: { CMS_GIT_ACTOR: 'release' },
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async function writeFiles(root: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, dirname(path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  }

  async function insertNode(
    parentPath: string,
    name: string,
    kind: string,
    storage: string,
    env: string = 'both',
  ) {
    const [parent] = await database.db
      .select()
      .from(schema.nodes)
      .where(eq(schema.nodes.path, parentPath));
    const [row] = await database.db
      .insert(schema.nodes)
      .values({
        parentId: parent!.id,
        name,
        path: `${parentPath}.${name}`,
        kind: kind as (typeof schema.nodeKinds)[number],
        storage: storage as (typeof schema.nodeStorages)[number],
        env: env as (typeof schema.nodeEnvs)[number],
        createdBy: ROOT_UID,
      })
      .returning();
    return row!;
  }

  async function nodeAt(path: string) {
    const [row] = await database.db.select().from(schema.nodes).where(eq(schema.nodes.path, path));
    return row;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async () => 'x' });
    // The pages and collections rules attach to content already created via the content agent.
    await insertNode('site.pages', 'catalogo', 'page', 'db');
    await insertNode('data.collections', 'prodotti', 'collection', 'db');

    dir = await mkdtemp(join(tmpdir(), 'ai-cms-cn-site-'));
    const templateDir = join(dir, 'template');
    await writeFiles(templateDir, {
      'app/page.tsx': 'export default () => null;\n',
      'app/(dynamic)/catalogo/page.tsx': 'export default () => null;\n',
      'components/ui/pulsante.tsx': 'export const Pulsante = () => null;\n',
      'components/ui/Button.tsx': 'export const Button = () => null;\n',
      'api/contatti.ts': 'export const POST = async () => new Response();\n',
      'lib/prezzi.ts': 'export const format = (n: number) => String(n);\n',
      'db/schema/prodotti.ts': 'export const prodotti = {};\n',
      'package.json': '{"name": "site"}\n',
      'cms.manifest.json': JSON.stringify(MANIFEST, null, 2),
    });
    paths = { gitRoot: join(dir, 'git'), workspacesRoot: join(dir, 'workspaces') };
    await initSiteRepo({ gitRoot: paths.gitRoot, templateDir });
  });

  afterAll(async () => {
    await database?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('reads the manifest and lists files at a ref', async () => {
    const bare = bareRepoPath(paths.gitRoot);
    const manifest = await loadManifest(bare, 'refs/heads/staging');
    expect(manifest.rules).toHaveLength(5);
    const files = await listRepoFiles(bare, 'refs/heads/staging');
    expect(files).toContain('api/contatti.ts');
    expect(files).toContain('cms.manifest.json');
  });

  it('returns an empty manifest for a ref with none', async () => {
    const dirNoManifest = await mkdtemp(join(tmpdir(), 'ai-cms-cn-nm-'));
    try {
      const noManifestTemplate = join(dirNoManifest, 'template');
      await writeFiles(noManifestTemplate, { 'app/page.tsx': 'x\n' });
      const noManifestPaths: SiteRepoPaths = {
        gitRoot: join(dirNoManifest, 'git'),
        workspacesRoot: join(dirNoManifest, 'workspaces'),
      };
      await initSiteRepo({ gitRoot: noManifestPaths.gitRoot, templateDir: noManifestTemplate });
      const manifest = await loadManifest(bareRepoPath(noManifestPaths.gitRoot), 'refs/heads/main');
      expect(manifest).toEqual({ version: 1, rules: [], files: [] });
    } finally {
      await rm(dirNoManifest, { recursive: true, force: true });
    }
  });

  it('creates git nodes for staging on first sync', async () => {
    const result = await syncCodeNodes(database.db, 'staging', { paths, actorUid: ROOT_UID });
    expect(result.commit).toBeTruthy();

    const byFile = new Map(result.outcomes.map((o) => [o.file, o]));
    expect(byFile.get('api/contatti.ts')).toMatchObject({
      status: 'created',
      path: '/code/api/contatti/ts',
    });
    expect(byFile.get('lib/prezzi.ts')).toMatchObject({ status: 'created' });
    expect(byFile.get('components/ui/pulsante.tsx')).toMatchObject({ status: 'created' });
    expect(byFile.get('app/(dynamic)/catalogo/page.tsx')).toMatchObject({
      status: 'created',
      // The manifest's `page.tsx` becomes two node segments ("page", "tsx"): a filename's dot
      // splits the ltree path the same way a "/" would (paths.ts §fromLtree/toLtree).
      path: '/site/pages/catalogo/page/tsx',
    });
    expect(byFile.get('db/schema/prodotti.ts')).toMatchObject({
      status: 'created',
      path: '/data/collections/prodotti/schema',
    });
    expect(byFile.get('package.json')).toBeUndefined();

    const leaf = await nodeAt('code.api.contatti.ts');
    expect(leaf).toMatchObject({ kind: 'file', storage: 'git', env: 'staging' });
    const middle = await nodeAt('code.api.contatti');
    expect(middle).toMatchObject({ kind: 'dir', storage: 'git' });

    const audit = await database.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'tree.git-sync'));
    expect(audit.length).toBeGreaterThan(0);
  });

  it('skips a page.tsx file for a page not yet in the tree', async () => {
    await commitToBranch('staging', async (work) => {
      await writeFiles(work, {
        'app/(dynamic)/non-esiste/page.tsx': 'export default () => null;\n',
      });
    });
    const result = await syncCodeNodes(database.db, 'staging', { paths, actorUid: ROOT_UID });
    const outcome = result.outcomes.find((o) => o.file === 'app/(dynamic)/non-esiste/page.tsx');
    expect(outcome).toMatchObject({ status: 'skipped-ancestor-missing' });
  });

  it('skips a file whose resolved path has an invalid node name', async () => {
    const result = await syncCodeNodes(database.db, 'staging', { paths, actorUid: ROOT_UID });
    const outcome = result.outcomes.find((o) => o.file === 'components/ui/Button.tsx');
    expect(outcome).toMatchObject({ status: 'skipped-invalid-name' });
  });

  it('is idempotent: a second sync leaves already-synced nodes unchanged', async () => {
    const result = await syncCodeNodes(database.db, 'staging', { paths, actorUid: ROOT_UID });
    const outcome = result.outcomes.find((o) => o.file === 'api/contatti.ts');
    expect(outcome).toMatchObject({ status: 'unchanged' });
  });

  it('promotes a staging node to "both" once the same file is released to prod', async () => {
    const before = await nodeAt('code.api.contatti.ts');
    expect(before?.env).toBe('staging');

    const result = await syncCodeNodes(database.db, 'prod', { paths, actorUid: ROOT_UID });
    const outcome = result.outcomes.find((o) => o.file === 'api/contatti.ts');
    expect(outcome).toMatchObject({ status: 'promoted' });

    const after = await nodeAt('code.api.contatti.ts');
    expect(after?.env).toBe('both');
  });

  it('demotes a "both" node when its file is removed from one env, and deletes it once removed from both', async () => {
    // Removed from staging only: still present in prod, so it is demoted rather than deleted.
    await commitToBranch('staging', async (work) => {
      await rm(join(work, 'api', 'contatti.ts'));
    });
    let result = await syncCodeNodes(database.db, 'staging', { paths, actorUid: ROOT_UID });
    expect(result.demoted).toContain('/code/api/contatti/ts');
    expect(result.deleted).not.toContain('/code/api/contatti/ts');
    let node = await nodeAt('code.api.contatti.ts');
    expect(node?.env).toBe('prod');
    expect(node?.deletedAt).toBeNull();

    // Now removed from prod too: nothing references it any more.
    await commitToBranch('main', async (work) => {
      await rm(join(work, 'api', 'contatti.ts'));
    });
    result = await syncCodeNodes(database.db, 'prod', { paths, actorUid: ROOT_UID });
    expect(result.deleted).toContain('/code/api/contatti/ts');
    node = await nodeAt('code.api.contatti.ts');
    expect(node?.deletedAt).not.toBeNull();
  });

  it('reports a conflict when the resolved path already exists with an incompatible kind', async () => {
    await insertNode('code.lib', 'gia-presente', 'dir', 'git');
    await insertNode('code.lib.gia-presente', 'ts', 'page', 'db');
    await commitToBranch('staging', async (work) => {
      await writeFiles(work, { 'lib/gia-presente.ts': 'export const x = 1;\n' });
    });
    const result = await syncCodeNodes(database.db, 'staging', { paths, actorUid: ROOT_UID });
    const outcome = result.outcomes.find((o) => o.file === 'lib/gia-presente.ts');
    expect(outcome?.status).toBe('skipped-conflict');
  });

  it('does nothing for an env whose branch has no commits yet', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'ai-cms-cn-empty-'));
    try {
      const emptyPaths: SiteRepoPaths = {
        gitRoot: join(emptyDir, 'git'),
        workspacesRoot: join(emptyDir, 'workspaces'),
      };
      await runGit([
        'init',
        '--quiet',
        '--bare',
        '--initial-branch=main',
        bareRepoPath(emptyPaths.gitRoot),
      ]);
      const result = await syncCodeNodes(database.db, 'staging', {
        paths: emptyPaths,
        actorUid: ROOT_UID,
      });
      expect(result).toEqual({
        env: 'staging',
        ref: 'refs/heads/staging',
        commit: '',
        outcomes: [],
        deleted: [],
        demoted: [],
      });
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});
