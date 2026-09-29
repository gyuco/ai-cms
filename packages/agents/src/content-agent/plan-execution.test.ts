/**
 * `previewContentPlan` / `confirmContentPlan` against a real database: the pure accumulator
 * and heuristics are covered without one in `plan.test.ts`, but the dry-run/commit split and
 * "clear on confirm" behavior only mean something against `executePlan`'s actual transaction.
 */
import type { Principal } from '@ai-cms/authz';
import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { getContent } from '@ai-cms/content/service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmContentPlan, createPlanSession, previewContentPlan } from './plan.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };

const page = (title: string) => ({ meta: { title }, blocks: [] });

describe.skipIf(!testDatabaseUrl)('previewContentPlan / confirmContentPlan', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('preview does not write, and leaves the session untouched', async () => {
    const session = createPlanSession();
    session.propose({
      op: 'createPage',
      parentPath: '/site/pages',
      name: 'anteprima',
      body: page('Anteprima'),
    });

    const result = await previewContentPlan(db(), root, 'prod', session);
    expect(result.dryRun).toBe(true);
    expect(result.preview?.[0]?.created).toBe(true);
    expect(session.isEmpty()).toBe(false);

    await expect(
      getContent(db(), root, 'prod', '/site/pages/anteprima', { version: 'latest' }),
    ).rejects.toThrow();
  });

  it('confirm writes for real, in one transaction, and clears the session', async () => {
    const session = createPlanSession();
    session.propose({
      op: 'createPage',
      parentPath: '/site/pages',
      name: 'confermata',
      body: page('Confermata'),
    });
    session.propose({ op: 'publish', path: '/site/pages/confermata' });

    const result = await confirmContentPlan(db(), root, 'prod', session);
    expect(result.dryRun).toBe(false);
    expect(result.published).toEqual(['/site/pages/confermata']);
    expect(session.isEmpty()).toBe(true);

    const content = await getContent(db(), root, 'prod', '/site/pages/confermata', {
      version: 'published',
    });
    expect(content.body).toEqual(page('Confermata'));
  });

  it('rolls back the whole plan on confirm when one operation fails, and keeps the session', async () => {
    const session = createPlanSession();
    session.propose({
      op: 'createPage',
      parentPath: '/site/pages',
      name: 'parziale',
      body: page('Parziale'),
    });
    session.propose({ op: 'updateBody', path: '/site/pages/non-esiste', body: page('x') });

    await expect(confirmContentPlan(db(), root, 'prod', session)).rejects.toThrow();
    expect(session.isEmpty()).toBe(false);
    await expect(
      getContent(db(), root, 'prod', '/site/pages/parziale', { version: 'latest' }),
    ).rejects.toThrow();
  });
});
