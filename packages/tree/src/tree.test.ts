import { AuthzError, contentAgentProfile, type Principal } from '@ai-cms/authz';
import { schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  createNode,
  deleteNode,
  getNode,
  listChildren,
  moveNode,
  parsePath,
  renameNode,
  restoreNode,
} from './index.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };

describe('parsePath', () => {
  it('accepts public and ltree paths', () => {
    expect(parsePath('/site/pages/blog')).toBe('site.pages.blog');
    expect(parsePath('/')).toBe('');
    expect(parsePath('site.pages')).toBe('site.pages');
  });

  it('rejects invalid segments', () => {
    expect(() => parsePath('/site/Pages')).toThrow(ValidationError);
    expect(() => parsePath('/site/pa ges')).toThrow(/Percorso non valido/);
  });
});

describe.skipIf(!testDatabaseUrl)('tree service', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  const auditRows = (action: string) =>
    db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(schema.auditLog.id);

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('reads nodes and lists children in public form', async () => {
    const node = await getNode(db(), root, 'prod', '/site/pages/index');
    expect(node).toMatchObject({ path: '/site/pages/index', kind: 'page', version: 1 });
    const children = await listChildren(db(), root, 'prod', '/site');
    expect(children.map((c) => c.path)).toEqual([
      '/site/assets',
      '/site/components',
      '/site/layouts',
      '/site/menus',
      '/site/pages',
      '/site/settings',
    ]);
    await expect(getNode(db(), root, 'prod', '/site/nope')).rejects.toThrow(NotFoundError);
  });

  it('creates nodes under a parent, with validation and audit', async () => {
    const blog = await createNode(db(), root, 'prod', '/site/pages', {
      name: 'blog',
      kind: 'page',
    });
    expect(blog).toMatchObject({
      path: '/site/pages/blog',
      ltreePath: 'site.pages.blog',
      storage: 'db',
      env: 'both',
      createdBy: 0,
    });
    await createNode(db(), root, 'prod', '/site/pages/blog', { name: 'post-1', kind: 'page' });

    await expect(
      createNode(db(), root, 'prod', '/site/pages', { name: 'blog', kind: 'page' }),
    ).rejects.toThrow(/Esiste già/);
    await expect(
      createNode(db(), root, 'prod', '/site/pages', { name: 'Blog!', kind: 'page' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      createNode(db(), root, 'prod', '/site/nope', { name: 'x', kind: 'page' }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      createNode(db(), root, 'prod', '/site/settings', { name: 'x', kind: 'page' }),
    ).rejects.toThrow(/non può contenere/);

    const audit = await auditRows('node.create');
    expect(audit.map((r) => [r.nodePath, r.outcome, r.env])).toEqual([
      ['site.pages.blog', 'ok', 'prod'],
      ['site.pages.blog.post-1', 'ok', 'prod'],
    ]);
  });

  it('inherits git storage and denies creating code in prod, auditing the denial', async () => {
    await expect(
      createNode(db(), root, 'prod', '/code/api', { name: 'contatti', kind: 'file' }),
    ).rejects.toThrow(AuthzError);
    const staging = await createNode(db(), root, 'staging', '/code/api', {
      name: 'contatti',
      kind: 'file',
    });
    expect(staging.storage).toBe('git');
    const denied = (await auditRows('node.create')).filter((r) => r.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ nodePath: 'code.api', env: 'prod' });
    expect(denied[0]!.details).toMatchObject({ code: 'invariant-I1', permission: 'create' });
  });

  it('keeps env-specific nodes out of the other environment', async () => {
    await createNode(db(), root, 'staging', '/site/pages', {
      name: 'bozza',
      kind: 'page',
      env: 'staging',
    });
    await expect(getNode(db(), root, 'prod', '/site/pages/bozza')).rejects.toThrow(NotFoundError);
    const prod = await listChildren(db(), root, 'prod', '/site/pages');
    expect(prod.map((n) => n.name)).not.toContain('bozza');
    await expect(
      createNode(db(), root, 'prod', '/site/pages', { name: 'x', kind: 'page', env: 'staging' }),
    ).rejects.toThrow(ValidationError);
  });

  it('respects agent profiles: the content agent cannot touch /system', async () => {
    const agent: Principal = { ...root, agent: contentAgentProfile };
    await expect(listChildren(db(), agent, 'prod', '/system')).rejects.toThrow(AuthzError);
    await expect(listChildren(db(), agent, 'prod', '/site')).resolves.toHaveLength(6);
  });

  it('moves a node with all its descendants in one step', async () => {
    await createNode(db(), root, 'prod', '/site/pages', { name: 'news', kind: 'dir' });
    await createNode(db(), root, 'prod', '/site/pages/blog/post-1', {
      name: 'allegati',
      kind: 'dir',
    });
    const before = await getNode(db(), root, 'prod', '/site/pages/blog');
    const moved = await moveNode(db(), root, 'prod', '/site/pages/blog', '/site/pages/news', {
      expectedVersion: before.version,
    });
    expect(moved).toMatchObject({ path: '/site/pages/news/blog', version: before.version + 1 });
    expect(moved.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());

    const deep = await getNode(db(), root, 'prod', '/site/pages/news/blog/post-1/allegati');
    expect(deep.version).toBe(2);
    await expect(getNode(db(), root, 'prod', '/site/pages/blog')).rejects.toThrow(NotFoundError);
    const parent = await getNode(db(), root, 'prod', '/site/pages/news');
    const [row] = await db().select().from(schema.nodes).where(eq(schema.nodes.id, moved.id));
    expect(row!.parentId).toBe(parent.id);
    const [{ count }] = (await db().execute(
      sql`SELECT count(*)::int AS count FROM nodes WHERE path <@ 'site.pages.news.blog'`,
    )) as unknown as [{ count: number }];
    expect(count).toBe(3);
  });

  it('refuses to move a node into itself or onto an existing name', async () => {
    await expect(
      moveNode(db(), root, 'prod', '/site/pages/news', '/site/pages/news/blog'),
    ).rejects.toThrow(/dentro se stesso/);
    await createNode(db(), root, 'prod', '/site/pages', { name: 'blog', kind: 'page' });
    await expect(
      moveNode(db(), root, 'prod', '/site/pages/blog', '/site/pages/news'),
    ).rejects.toThrow(/Esiste già/);
    await expect(moveNode(db(), root, 'prod', '/site/pages', '/data')).rejects.toThrow(
      /struttura di base/,
    );
  });

  it('detects conflicts with the expected version', async () => {
    const node = await getNode(db(), root, 'prod', '/site/pages/blog');
    await renameNode(db(), root, 'prod', '/site/pages/blog', 'diario', {
      expectedVersion: node.version,
    });
    let error: unknown;
    try {
      await renameNode(db(), root, 'prod', '/site/pages/diario', 'giornale', {
        expectedVersion: node.version,
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).currentVersion).toBe(node.version + 1);
    expect((error as ConflictError).message).toContain('Conflitto');
    await expect(getNode(db(), root, 'prod', '/site/pages/diario')).resolves.toBeDefined();
  });

  it('soft-deletes a subtree and restores it', async () => {
    const deleted = await deleteNode(db(), root, 'prod', '/site/pages/news/blog');
    expect(deleted.deletedAt).not.toBeNull();
    await expect(
      getNode(db(), root, 'prod', '/site/pages/news/blog/post-1/allegati'),
    ).rejects.toThrow(NotFoundError);
    const rows = await db()
      .select()
      .from(schema.nodes)
      .where(and(sql`${schema.nodes.path} <@ 'site.pages.news.blog'`));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.deletedAt?.getTime() === deleted.deletedAt!.getTime())).toBe(true);

    // The name is free again while the node is in the trash.
    const other = await createNode(db(), root, 'prod', '/site/pages/news', {
      name: 'blog',
      kind: 'page',
    });
    await expect(restoreNode(db(), root, 'prod', '/site/pages/news/blog')).rejects.toThrow(
      /Esiste già/,
    );
    await deleteNode(db(), root, 'prod', '/site/pages/news/blog', {
      expectedVersion: other.version,
    });

    const restored = await restoreNode(db(), root, 'prod', '/site/pages/news/blog', {
      id: deleted.id,
    });
    expect(restored.deletedAt).toBeNull();
    await expect(
      getNode(db(), root, 'prod', '/site/pages/news/blog/post-1/allegati'),
    ).resolves.toBeDefined();
    await expect(deleteNode(db(), root, 'prod', '/site/pages')).rejects.toThrow(
      /struttura di base/,
    );
  });

  it('rolls back when a nested operation fails in an outer transaction', async () => {
    await expect(
      db().transaction(async (tx) => {
        await createNode(tx, root, 'prod', '/site/pages', { name: 'tmp', kind: 'page' });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    await expect(getNode(db(), root, 'prod', '/site/pages/tmp')).rejects.toThrow(NotFoundError);
  });
});
