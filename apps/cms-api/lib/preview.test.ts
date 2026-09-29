import { schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { SHARED_NODES } from '@ai-cms/site-kit/paths';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestNodeVersion } from './preview.ts';

describe.skipIf(!testDatabaseUrl)('draft preview of shared nodes (FR-150)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function insertHeader() {
    const [node] = await database.db
      .insert(schema.nodes)
      .values({
        path: 'site.layouts.header',
        name: 'header',
        kind: 'layout',
        storage: 'db',
        env: 'both',
        createdBy: 0,
      } as never)
      .returning();
    await database.db.insert(schema.contentVersions).values({
      nodeId: node!.id,
      env: 'staging',
      version: 1,
      body: { blocks: [{ id: 'h', type: 'paragraph', content: [] }] },
      authorUid: 0,
    } as never);
  }

  it('only names shared nodes with their kind', () => {
    expect(SHARED_NODES).toEqual({
      'site.settings': 'setting',
      'site.layouts.header': 'layout',
      'site.layouts.footer': 'layout',
      'site.menus.main': 'menu',
    });
  });

  it('returns the unpublished latest version of the header', async () => {
    await insertHeader();
    const latest = await latestNodeVersion('staging', 'site.layouts.header', 'layout', database.db);
    expect(latest).toMatchObject({ version: 1, published: false });
    expect(latest?.target.kind).toBe('layout');
  });

  it('does not return a node of another kind or another environment', async () => {
    expect(
      await latestNodeVersion('staging', 'site.layouts.header', 'page', database.db),
    ).toBeNull();
    expect(
      await latestNodeVersion('prod', 'site.layouts.header', 'layout', database.db),
    ).toBeNull();
    expect(
      await latestNodeVersion('staging', 'site.layouts.footer', 'layout', database.db),
    ).toBeNull();
  });

  it('reports the published settings as published', async () => {
    const latest = await latestNodeVersion('prod', 'site.settings', 'setting', database.db);
    expect(latest).toMatchObject({ version: 1, published: true });
  });
});
