import type { Principal } from '@ai-cms/authz';
import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { ValidationError, createNode, getNode } from '@ai-cms/tree';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureSharedNodes,
  getLayout,
  getMenu,
  getSharedElements,
  getSiteSettings,
  publish,
  saveDraft,
} from './index.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };

describe.skipIf(!testDatabaseUrl)('shared site elements', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('reads the seeded site settings and publishes changes', async () => {
    expect(await getSiteSettings(db(), root, 'prod')).toMatchObject({
      name: 'Nuovo sito',
      lang: 'it',
    });
    await saveDraft(db(), root, 'staging', '/site/settings', {
      name: 'Bottega',
      lang: 'it',
      titleTemplate: '%s · Bottega',
    });
    expect((await getSiteSettings(db(), root, 'staging')).name).toBe('Nuovo sito');
    await publish(db(), root, 'staging', '/site/settings');
    expect((await getSiteSettings(db(), root, 'staging')).name).toBe('Bottega');
    expect((await getSiteSettings(db(), root, 'prod')).name).toBe('Nuovo sito');
  });

  it('creates header, footer and main menu on demand', async () => {
    expect(await getLayout(db(), root, 'prod', 'header')).toBeNull();
    const created = await ensureSharedNodes(db(), root, 'prod');
    expect(created.map((n) => [n.path, n.kind])).toEqual([
      ['/site/layouts/header', 'layout'],
      ['/site/layouts/footer', 'layout'],
      ['/site/menus/main', 'menu'],
    ]);
    // Idempotent.
    const again = await ensureSharedNodes(db(), root, 'prod');
    expect(again.map((n) => n.id)).toEqual(created.map((n) => n.id));
    // Created but not published yet.
    expect(await getLayout(db(), root, 'prod', 'header')).toBeNull();
    expect(await getLayout(db(), root, 'prod', 'sidebar', { createIfMissing: true })).toBeNull();
    expect((await getNode(db(), root, 'prod', '/site/layouts/sidebar')).kind).toBe('layout');
  });

  it('returns published layouts and menus, and all shared elements at once', async () => {
    await saveDraft(db(), root, 'prod', '/site/layouts/header', {
      blocks: [{ id: 'logo', type: 'heading', level: 1, text: 'Bottega' }],
    });
    await publish(db(), root, 'prod', '/site/layouts/header');
    await saveDraft(db(), root, 'prod', '/site/menus/main', {
      items: [
        { label: 'Home', href: '/' },
        { label: 'Chi siamo', href: '/chi-siamo' },
      ],
    });
    await publish(db(), root, 'prod', '/site/menus/main');

    expect(await getLayout(db(), root, 'prod', 'header')).toEqual({
      blocks: [{ id: 'logo', type: 'heading', level: 1, text: 'Bottega' }],
    });
    expect((await getMenu(db(), root, 'prod', 'main'))?.items).toHaveLength(2);
    expect(await getMenu(db(), root, 'staging', 'main')).toBeNull();

    const shared = await getSharedElements(db(), root, 'prod');
    expect(shared.settings?.name).toBe('Nuovo sito');
    expect(Object.keys(shared.layouts)).toEqual(['header']);
    expect(Object.keys(shared.menus)).toEqual(['main']);
  });

  it('refuses a node of the wrong kind', async () => {
    await createNode(db(), root, 'prod', '/site/layouts', { name: 'strano', kind: 'dir' });
    await expect(getLayout(db(), root, 'prod', 'strano')).rejects.toThrow(ValidationError);
  });
});
