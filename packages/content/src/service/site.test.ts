import type { Principal } from '@ai-cms/authz';
import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { ConflictError, ValidationError, lookupNode } from '@ai-cms/tree';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createPage,
  deletePage,
  ensureSharedNodes,
  getSiteOverview,
  getSiteSettings,
  listTreeEntries,
  movePage,
  publish,
  renamePage,
  saveSiteSettings,
} from './index.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };

describe.skipIf(!testDatabaseUrl)('site services', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
    await createPage(db(), root, 'prod', '/site/pages', { name: 'progetti', title: 'Progetti' });
    await createPage(db(), root, 'prod', '/site/pages/progetti', { name: 'casa', title: 'Casa' });
    await createPage(db(), root, 'prod', '/site/pages', { name: 'contatti' });
    await publish(db(), root, 'prod', '/site/pages/contatti');
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('lists the pages with title, state and children', async () => {
    const entries = await listTreeEntries(db(), root, 'prod', '/site/pages');
    expect(
      entries.map((e) => [e.name, e.url, e.title, e.hasChildren, e.status.publishedVersion]),
    ).toEqual([
      ['contatti', '/contatti', null, false, 1],
      ['index', '/', null, false, 1],
      ['progetti', '/progetti', 'Progetti', true, null],
    ]);
    expect(entries[2]!.status).toEqual({
      latestVersion: 1,
      publishedVersion: null,
      hasDraft: true,
    });
    // Nodes are shared by both environments; their content is not.
    const staging = await listTreeEntries(db(), root, 'staging', '/site/pages');
    expect(staging.map((e) => [e.name, e.title, e.status.latestVersion])).toEqual([
      ['contatti', null, null],
      ['index', null, 1],
      ['progetti', null, null],
    ]);
  });

  it('renames, moves and deletes pages, only inside /site/pages', async () => {
    const [progetti] = (await listTreeEntries(db(), root, 'prod', '/site/pages')).filter(
      (e) => e.name === 'progetti',
    );
    await expect(
      renamePage(db(), root, 'prod', '/site/pages/progetti', 'lavori', { expectedVersion: 99 }),
    ).rejects.toBeInstanceOf(ConflictError);
    const renamed = await renamePage(db(), root, 'prod', '/site/pages/progetti', 'lavori', {
      expectedVersion: progetti!.version,
    });
    expect(renamed.path).toBe('/site/pages/lavori');
    expect(await lookupNode(db(), 'site.pages.lavori.casa', 'prod')).not.toBeNull();

    const moved = await movePage(db(), root, 'prod', '/site/pages/contatti', '/site/pages/lavori');
    expect(moved.path).toBe('/site/pages/lavori/contatti');
    await expect(
      movePage(db(), root, 'prod', '/site/pages/lavori', '/site/layouts'),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(renamePage(db(), root, 'prod', '/site/settings', 'x')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(deletePage(db(), root, 'prod', '/site/pages/index')).rejects.toThrow(
      'struttura di base',
    );

    await deletePage(db(), root, 'prod', '/site/pages/lavori');
    expect(await lookupNode(db(), 'site.pages.lavori.casa', 'prod')).toBeNull();
    expect((await listTreeEntries(db(), root, 'prod', '/site/pages')).map((e) => e.name)).toEqual([
      'index',
    ]);
  });

  it('saves and publishes the site settings in one step', async () => {
    const hook = vi.fn(async () => {});
    const overview = await getSiteOverview(db(), root, 'staging');
    expect(overview.settings.value).toMatchObject({ name: 'Nuovo sito', lang: 'it' });
    expect(overview.settings.version).toBe(1);

    const saved = await saveSiteSettings(
      db(),
      root,
      'staging',
      { name: 'Studio Rossi', lang: 'it', titleTemplate: '%s · Studio Rossi' },
      { expectedVersion: 1, onPublished: hook },
    );
    expect(saved).toEqual({ version: 2 });
    expect(hook).toHaveBeenCalledWith(['/site/settings'], 'staging');
    expect((await getSiteSettings(db(), root, 'staging')).name).toBe('Studio Rossi');
    expect((await getSiteSettings(db(), root, 'prod')).name).toBe('Nuovo sito');

    await expect(
      saveSiteSettings(db(), root, 'staging', { name: 'x', lang: 'it', titleTemplate: 'senza' }),
    ).rejects.toThrow('%s');
    const failing = await saveSiteSettings(
      db(),
      root,
      'staging',
      { name: 'Studio Rossi', lang: 'en', titleTemplate: '%s · Studio Rossi' },
      {
        onPublished: async () => {
          throw new Error('sito spento');
        },
      },
    );
    expect(failing).toEqual({ version: 3, hookError: 'sito spento' });
  });

  it('lists layouts and menus with their state', async () => {
    await ensureSharedNodes(db(), root, 'prod');
    const overview = await getSiteOverview(db(), root, 'prod');
    expect(overview.layouts.map((l) => [l.name, l.path, l.status.latestVersion])).toEqual([
      ['footer', '/site/layouts/footer', null],
      ['header', '/site/layouts/header', null],
    ]);
    expect(overview.menus.map((m) => m.name)).toEqual(['main']);
  });
});
