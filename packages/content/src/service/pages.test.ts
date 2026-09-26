import type { Principal } from '@ai-cms/authz';
import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { schema } from '@ai-cms/db';
import { ConflictError, NotFoundError, ValidationError, createNode } from '@ai-cms/tree';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPage,
  getContent,
  getPageContext,
  getPageDetails,
  publish,
  savePageMeta,
  saveDraft,
} from './index.ts';
import { dropBlank } from './pages.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };
const suspended: Principal = { uid: 0, username: 'root', status: 'suspended' };
const anna: Principal = { uid: 1000, username: 'anna', status: 'active' };

describe.skipIf(!testDatabaseUrl)('page services', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
    await database.db
      .insert(schema.users)
      .values({ uid: 1000, username: 'anna', email: 'anna@x.test', displayName: 'Anna Bianchi' });
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

  describe('createPage', () => {
    it('creates a page with an unpublished first version', async () => {
      const result = await createPage(db(), root, 'prod', '/site/pages', {
        name: 'chi-siamo',
        title: ' Chi siamo ',
      });
      expect(result.url).toBe('/chi-siamo');
      expect(result.node.kind).toBe('page');
      const content = await getContent(db(), root, 'prod', '/site/pages/chi-siamo');
      expect(content.body).toEqual({ meta: { title: 'Chi siamo' }, blocks: [] });
      expect(content.published).toBe(false);

      const child = await createPage(db(), root, 'prod', '/site/pages/chi-siamo', { name: 'team' });
      expect(child.url).toBe('/chi-siamo/team');
    });

    it('refuses pages outside /site/pages, bad names and missing parents', async () => {
      await expect(
        createPage(db(), root, 'prod', '/site/layouts', { name: 'x' }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        createPage(db(), root, 'prod', '/site/pages', { name: 'Chi Siamo' }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        createPage(db(), root, 'prod', '/site/pages/nessuna', { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        createPage(db(), root, 'prod', '/site/pages', { name: 'chi-siamo' }),
      ).rejects.toThrow('Esiste già');
    });
  });

  describe('page metadata and details', () => {
    it('saves metadata keeping the blocks, dropping blank fields', async () => {
      await createNode(db(), root, 'staging', '/site/pages', { name: 'servizi', kind: 'page' });
      const blocks = [{ type: 'heading', id: 'h1', level: 1, text: 'Servizi' }];
      await saveDraft(db(), anna, 'staging', '/site/pages/servizi', { meta: {}, blocks });
      const saved = await savePageMeta(
        db(),
        root,
        'staging',
        '/site/pages/servizi',
        { title: 'Servizi', description: '  ', og: { title: 'Servizi dello studio', image: '' } },
        { expectedVersion: 1 },
      );
      expect(saved.version).toBe(2);
      expect(saved.body).toMatchObject({
        meta: { title: 'Servizi', og: { title: 'Servizi dello studio' } },
      });
      expect((saved.body as { blocks: unknown[] }).blocks).toHaveLength(1);
      expect((saved.body as { meta: object }).meta).not.toHaveProperty('description');

      await expect(
        savePageMeta(db(), root, 'staging', '/site/pages/servizi', {}, { expectedVersion: 1 }),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        savePageMeta(db(), root, 'staging', '/site/pages/servizi', { title: 'x'.repeat(500) }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        savePageMeta(db(), root, 'staging', '/site/settings', { title: 'x' }),
      ).rejects.toThrow('non è una pagina');
    });

    it('returns state, metadata and versions with their authors', async () => {
      await publish(db(), root, 'staging', '/site/pages/servizi', { version: 1 });
      const details = await getPageDetails(db(), root, 'staging', '/site/pages/servizi');
      expect(details.node).toMatchObject({ path: '/site/pages/servizi', url: '/servizi' });
      expect(details.status).toEqual({ latestVersion: 2, publishedVersion: 1, hasDraft: true });
      expect(details.meta.title).toBe('Servizi');
      expect(details.versions.map((v) => [v.version, v.authorName, v.published])).toEqual([
        [2, 'Root', false],
        [1, 'Anna Bianchi', true],
      ]);
      await expect(
        getPageDetails(db(), suspended, 'staging', '/site/pages/servizi'),
      ).rejects.toThrow();
    });
  });

  it('dropBlank removes blank strings and empty objects', () => {
    expect(dropBlank({ a: ' ', b: 'x', c: { d: '' }, e: [''] })).toEqual({ b: 'x', e: [''] });
    expect(dropBlank({ a: '' })).toBeUndefined();
  });
});
