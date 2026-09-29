import { AuthzError, contentAgentProfile, type Principal } from '@ai-cms/authz';
import { schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { ConflictError, NotFoundError, ValidationError, createNode } from '@ai-cms/tree';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  diffVersions,
  getContent,
  listVersions,
  publish,
  restoreVersion,
  saveDraft,
  unpublish,
} from './index.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };
const agent: Principal = { ...root, agent: contentAgentProfile };

const page = (title: string, ...texts: string[]) => ({
  meta: { title },
  blocks: texts.map((text, i) => ({ id: `b${i}`, type: 'paragraph', content: [{ text }] })),
});

describe.skipIf(!testDatabaseUrl)('content versions and publication', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  const published = async (path: string, env: string) => {
    const rows = await database.sql`
      SELECT body, version FROM published_content WHERE path = ${path}::ltree AND env = ${env}`;
    return rows[0] as { body: unknown; version: number } | undefined;
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
    await createNode(db(), root, 'prod', '/site/pages', { name: 'chi-siamo', kind: 'page' });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('saves normalized drafts as new versions', async () => {
    const v1 = await saveDraft(
      db(),
      root,
      'prod',
      '/site/pages/chi-siamo',
      page('Chi siamo', 'Uno'),
    );
    expect(v1).toMatchObject({ version: 1, env: 'prod', authorUid: 0, viaAgent: null });
    const v2 = await saveDraft(
      db(),
      agent,
      'prod',
      '/site/pages/chi-siamo',
      {
        meta: { title: 'Chi siamo' },
        blocks: [{ id: 'h', type: 'html', html: '<p onclick="x()">Ciao</p><script>x()</script>' }],
      },
      { expectedVersion: 1, conversationId: '00000000-0000-4000-8000-000000000001' },
    );
    expect(v2).toMatchObject({ version: 2, viaAgent: 'content-agent' });
    expect(JSON.stringify(v2.body)).not.toMatch(/script|onclick/);
    // Versions are per environment.
    const staging = await saveDraft(db(), root, 'staging', '/site/pages/chi-siamo', page('S'));
    expect(staging.version).toBe(1);

    const audit = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'content.write'));
    expect(audit).toHaveLength(3);
    expect(audit[1]).toMatchObject({ agent: 'content-agent', nodePath: 'site.pages.chi-siamo' });
  });

  it('rejects invalid bodies with readable Italian messages', async () => {
    const error = await saveDraft(db(), root, 'prod', '/site/pages/chi-siamo', {
      meta: {},
      blocks: [{ id: 'x', type: 'heading', level: 9, text: 'T' }],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toContain('blocks[0].level');
    expect((error as ValidationError).message).toContain('tra 1 e 6');
    await expect(saveDraft(db(), root, 'prod', '/site/pages', page('x'))).rejects.toThrow(
      /non hanno un contenuto/,
    );
    await expect(
      saveDraft(db(), root, 'prod', '/site/settings', {
        name: 'Sito',
        lang: 'it',
        titleTemplate: 'x',
      }),
    ).rejects.toThrow(/%s/);
  });

  it('detects conflicting saves', async () => {
    const error = await saveDraft(db(), root, 'prod', '/site/pages/chi-siamo', page('Tardi'), {
      expectedVersion: 1,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ expectedVersion: 1, currentVersion: 2 });
  });

  it('serializes concurrent saves into consecutive versions', async () => {
    await createNode(db(), root, 'prod', '/site/pages', { name: 'corsa', kind: 'page' });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        saveDraft(db(), root, 'prod', '/site/pages/corsa', page(`T${i}`)),
      ),
    );
    expect(results.map((r) => r.version).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads, lists and compares versions', async () => {
    const latest = await getContent(db(), root, 'prod', '/site/pages/chi-siamo');
    expect(latest).toMatchObject({ version: 2, published: false, node: { kind: 'page' } });
    const first = await getContent(db(), root, 'prod', '/site/pages/chi-siamo', { version: 1 });
    expect(first.body).toEqual(page('Chi siamo', 'Uno'));
    await expect(
      getContent(db(), root, 'prod', '/site/pages/chi-siamo', { version: 'published' }),
    ).rejects.toThrow(NotFoundError);

    const versions = await listVersions(db(), root, 'prod', '/site/pages/chi-siamo');
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]).not.toHaveProperty('body');

    const { diff, from, to } = await diffVersions(
      db(),
      root,
      'prod',
      '/site/pages/chi-siamo',
      1,
      'latest',
    );
    expect([from, to]).toEqual([1, 2]);
    expect(diff.blocks.removed.map((b) => b.id)).toEqual(['b0']);
    expect(diff.blocks.added.map((b) => b.id)).toEqual(['h']);
    expect(diff.fields).toEqual([]);
  });

  it('publishes and unpublishes, visible through published_content', async () => {
    const hook = vi.fn(async () => {});
    const result = await publish(db(), root, 'prod', '/site/pages/chi-siamo', {
      version: 1,
      onPublished: hook,
    });
    expect(result).toMatchObject({
      status: 'published',
      version: 1,
      path: '/site/pages/chi-siamo',
    });
    expect(hook).toHaveBeenCalledWith(['/site/pages/chi-siamo'], 'prod');
    expect(await published('site.pages.chi-siamo', 'prod')).toMatchObject({ version: 1 });
    expect(await published('site.pages.chi-siamo', 'staging')).toBeUndefined();

    await publish(db(), root, 'prod', '/site/pages/chi-siamo');
    expect(await published('site.pages.chi-siamo', 'prod')).toMatchObject({ version: 2 });
    const snapshot = await getContent(db(), root, 'prod', '/site/pages/chi-siamo', {
      version: 'published',
    });
    expect(snapshot).toMatchObject({ version: 2, published: true });

    const failing = await publish(db(), root, 'prod', '/site/pages/chi-siamo', {
      onPublished: async () => {
        throw new Error('sito irraggiungibile');
      },
    });
    expect(failing.hookError).toBe('sito irraggiungibile');

    const off = await unpublish(db(), root, 'prod', '/site/pages/chi-siamo');
    expect(off.status).toBe('archived');
    expect(await published('site.pages.chi-siamo', 'prod')).toBeUndefined();
    const [row] = await database.sql`
      SELECT p.status FROM publications p JOIN nodes n ON n.id = p.node_id
      WHERE n.path = 'site.pages.chi-siamo' AND p.env = 'prod'`;
    expect(row!.status).toBe('archived');
    await expect(
      publish(db(), root, 'prod', '/site/pages/chi-siamo', { versionId: 999_999 }),
    ).rejects.toThrow(NotFoundError);
  });

  it('refuses to publish a version with blocking HTML errors and explains why (FR-168)', async () => {
    const validateRendered = vi.fn(async () => ({ errors: ['Manca il <title> della pagina.'] }));
    await expect(
      publish(db(), root, 'prod', '/site/pages/chi-siamo', { validateRendered }),
    ).rejects.toThrow(ValidationError);
    expect(await published('site.pages.chi-siamo', 'prod')).toBeUndefined();

    const error = await publish(db(), root, 'prod', '/site/pages/chi-siamo', {
      validateRendered,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    const failure = error as ValidationError;
    // The user always sees the reason, not just a failure.
    expect(failure.message).toContain('non è pubblicabile');
    expect(failure.message).toContain('Manca il <title> della pagina.');
    expect(failure.issues).toEqual(['Manca il <title> della pagina.']);
    // The version that would have gone online is the one that was checked.
    const snapshot = await getContent(db(), root, 'prod', '/site/pages/chi-siamo', {
      version: 'latest',
    });
    expect(validateRendered).toHaveBeenCalledWith('/site/pages/chi-siamo', snapshot.body);
  });

  it('publishes normally when the validator finds nothing', async () => {
    const validateRendered = vi.fn(async () => ({ errors: [] }));
    const result = await publish(db(), root, 'prod', '/site/pages/chi-siamo', { validateRendered });
    expect(result.status).toBe('published');
    expect(await published('site.pages.chi-siamo', 'prod')).toMatchObject({ version: 2 });
  });

  it('restores an earlier version as a new one', async () => {
    const restored = await restoreVersion(db(), root, 'prod', '/site/pages/chi-siamo', 1, {
      expectedVersion: 2,
    });
    expect(restored.version).toBe(3);
    expect(restored.body).toEqual(page('Chi siamo', 'Uno'));
    const [audit] = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'content.restore'));
    expect(audit!.details).toMatchObject({ restoredFrom: 1, version: 3 });
  });

  it('lets authz block git nodes in prod and allows db content in prod', async () => {
    await createNode(db(), root, 'staging', '/site/components', { name: 'hero', kind: 'file' });
    await expect(saveDraft(db(), root, 'prod', '/site/components/hero', page('x'))).rejects.toThrow(
      AuthzError,
    );
    await expect(
      saveDraft(db(), root, 'staging', '/site/components/hero', page('x')),
    ).rejects.toThrow(ValidationError);
    const [denied] = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.outcome, 'denied'));
    expect(denied).toMatchObject({ action: 'content.write', nodePath: 'site.components.hero' });
  });
});
