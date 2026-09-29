import type { Principal } from '@ai-cms/authz';
import { ensureSharedNodes, publish, saveDraft } from '@ai-cms/content/service';
import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { createNode } from '@ai-cms/tree';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPageVersion } from './page-rules.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };

/** A page body as `saveDraft` stores it, with the blocks the agent would write. */
const page = (title: string, ...headings: string[]) => ({
  meta: { title },
  blocks: headings.map((text, i) => ({ id: `h${i}`, type: 'heading', level: 1, text })),
});

describe.skipIf(!testDatabaseUrl)('HTML rules before publishing (E6.7)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  const check = (path: string, body: unknown, env: 'prod' | 'staging' = 'prod') =>
    checkPageVersion(db(), root, env, path, body);

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
    await createNode(db(), root, 'prod', '/site/pages', { name: 'chi-siamo', kind: 'page' });
    await createNode(db(), root, 'prod', '/site/pages', { name: 'contatti', kind: 'page' });
    await ensureSharedNodes(db(), root, 'prod');
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('accepts a page with one heading and gives no blocking error', async () => {
    const result = await check('/site/pages/chi-siamo', page('Chi siamo', 'Chi siamo'));
    expect(result.errors).toEqual([]);
  });

  it('blocks a page with two <h1> and explains why', async () => {
    const result = await check('/site/pages/chi-siamo', page('Chi siamo', 'Uno', 'Due'));
    expect(result.errors.join('\n')).toContain('più di un <h1>');
    // The message tells the editor what to do, not only that something is wrong.
    expect(result.errors.join('\n')).toContain('<h2>');
  });

  it('reports the position of the violation so the editor can find it', async () => {
    const result = await check('/site/pages/chi-siamo', page('Chi siamo', 'Uno', 'Due'));
    expect(result.errors.some((line) => /riga \d+/.test(line))).toBe(true);
  });

  it('blocks a title already used by another published page', async () => {
    await saveDraft(db(), root, 'prod', '/site/pages/contatti', page('Chi siamo', 'Contatti'));
    await publish(db(), root, 'prod', '/site/pages/contatti');
    const result = await check('/site/pages/chi-siamo', page('Chi siamo', 'Chi siamo'));
    expect(result.errors.join('\n')).toMatch(/titolo/i);
  });

  it('does not compare with the drafts of the other pages, only with what is online', async () => {
    // 'Contatti' is published; a page called 'Bottega' exists only as a draft.
    await saveDraft(db(), root, 'prod', '/site/pages/chi-siamo', page('Bottega', 'Bottega'));
    const result = await check('/site/pages/chi-siamo', page('Bottega', 'Bottega'));
    expect(result.errors).toEqual([]);
  });

  it('keeps warnings out of the blocking errors (FR-168)', async () => {
    const result = await check('/site/pages/chi-siamo', {
      meta: { title: 'Bottega' },
      blocks: [{ id: 'h', type: 'heading', level: 1, text: 'Bottega' }],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('checks against the settings of the environment it publishes in', async () => {
    await saveDraft(db(), root, 'staging', '/site/settings', {
      name: 'Bottega',
      lang: 'en',
      titleTemplate: '%s | Bottega',
    });
    await publish(db(), root, 'staging', '/site/settings');
    // In staging the title template is the English one, so a prod title does not collide.
    const result = await check('/site/pages/chi-siamo', page('Chi siamo', 'Chi siamo'), 'staging');
    expect(result.errors).toEqual([]);
  });

  // Last: a broken header would make every other check fail, and that is the point here.
  it('reports a violation inside the published header, as the site renders it', async () => {
    await saveDraft(db(), root, 'prod', '/site/layouts/header', {
      blocks: [
        { id: 'a', type: 'heading', level: 2, text: 'Servizi' },
        { id: 'b', type: 'heading', level: 4, text: 'Dettagli' },
      ],
    });
    await publish(db(), root, 'prod', '/site/layouts/header');
    const result = await check('/site/pages/chi-siamo', page('Bottega', 'Bottega'));
    expect(result.errors.join('\n')).toMatch(/h2|h4/i);
  });

  it('lets settings and menus through: they hold data, not markup', async () => {
    const settings = { name: 'Bottega', lang: 'it', titleTemplate: '%s · Bottega' };
    expect(await check('/site/settings', settings)).toEqual({ errors: [], warnings: [] });
    expect(await check('/site/menus/main', { items: [{ label: 'Home', href: '/' }] })).toEqual({
      errors: [],
      warnings: [],
    });
  });
});
