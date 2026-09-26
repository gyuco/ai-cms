import type { Principal } from '@ai-cms/authz';
import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { createNode } from '@ai-cms/tree';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPageContext, publish, saveDraft } from './index.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };
const suspended: Principal = { uid: 0, username: 'root', status: 'suspended' };

describe.skipIf(!testDatabaseUrl)('page services', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
  });

  afterAll(async () => {
    await database?.drop();
  });

  describe('getPageContext', () => {
    it('describes the seeded home page', async () => {
      expect(await getPageContext(db(), root, 'prod', '/')).toEqual({
        node: { path: '/site/pages/index', kind: 'page', exists: true, version: 1 },
        page: { latestVersion: 1, publishedVersion: 1, hasDraft: false },
      });
    });

    it('reports a missing page and URLs that cannot be pages', async () => {
      expect(await getPageContext(db(), root, 'prod', '/chi-siamo/team')).toEqual({
        node: { path: '/site/pages/chi-siamo/team', kind: null, exists: false, version: null },
        page: null,
      });
      expect((await getPageContext(db(), root, 'prod', '/Chi-Siamo')).node.path).toBeNull();
    });

    it('tracks drafts and publication per environment', async () => {
      await createNode(db(), root, 'prod', '/site/pages', { name: 'contatti', kind: 'page' });
      expect((await getPageContext(db(), root, 'prod', '/contatti')).page).toEqual({
        latestVersion: null,
        publishedVersion: null,
        hasDraft: false,
      });
      await saveDraft(db(), root, 'prod', '/site/pages/contatti', { meta: {}, blocks: [] });
      expect((await getPageContext(db(), root, 'prod', '/contatti')).page).toEqual({
        latestVersion: 1,
        publishedVersion: null,
        hasDraft: true,
      });
      await publish(db(), root, 'prod', '/site/pages/contatti');
      expect((await getPageContext(db(), root, 'prod', '/contatti')).page?.hasDraft).toBe(false);
      expect((await getPageContext(db(), root, 'staging', '/contatti')).page).toEqual({
        latestVersion: null,
        publishedVersion: null,
        hasDraft: false,
      });
    });

    it('hides the page state from whoever cannot read it', async () => {
      const context = await getPageContext(db(), suspended, 'prod', '/');
      expect(context.node.exists).toBe(true);
      expect(context.page).toBeNull();
    });
  });
});
