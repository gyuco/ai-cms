import { randomBytes } from 'node:crypto';
import { schema, seed, SYSTEM_UID } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeContentDb,
  ContentUnavailableError,
  listPublishedPages,
  readPublished,
} from './content.ts';

describe.skipIf(!testDatabaseUrl)('published content', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const role = `site_ro_${randomBytes(4).toString('hex')}`;
  const previousUrl = process.env.CORE_DATABASE_URL;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async () => 'x' });
    const [pages] = await database.db
      .select()
      .from(schema.nodes)
      .where(sql`${schema.nodes.path} = 'site.pages'::ltree`);
    // A published page, and a draft that must stay invisible.
    for (const [name, publish] of [
      ['chi-siamo', true],
      ['bozza', false],
    ] as const) {
      const [node] = await database.db
        .insert(schema.nodes)
        .values({
          parentId: pages!.id,
          name,
          path: `site.pages.${name}`,
          kind: 'page',
          createdBy: SYSTEM_UID,
        })
        .returning();
      const [version] = await database.db
        .insert(schema.contentVersions)
        .values({
          nodeId: node!.id,
          env: 'prod',
          version: 1,
          body: { meta: { title: name }, blocks: [] },
          authorUid: SYSTEM_UID,
        })
        .returning();
      if (publish) {
        await database.db.insert(schema.publications).values({
          nodeId: node!.id,
          env: 'prod',
          versionId: version!.id,
          status: 'published',
          publishedBy: SYSTEM_UID,
        });
      }
    }
    // Read through a login role with only the site's privileges (member of cms_content_ro).
    await database.sql.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD 'pw' IN ROLE cms_content_ro; GRANT CONNECT ON DATABASE ${new URL(database.url).pathname.slice(1)} TO ${role}`,
    );
    const url = new URL(database.url);
    url.username = role;
    url.password = 'pw';
    process.env.CORE_DATABASE_URL = url.toString();
  });

  afterAll(async () => {
    await closeContentDb();
    if (previousUrl === undefined) delete process.env.CORE_DATABASE_URL;
    else process.env.CORE_DATABASE_URL = previousUrl;
    await database?.drop();
    const admin = (await import('postgres')).default(testDatabaseUrl!, { max: 1 });
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('reads the seeded home page and settings', async () => {
    const home = await readPublished('prod', 'site.pages.index');
    expect(home).toMatchObject({ path: 'site.pages.index', kind: 'page', version: 1 });
    expect(home?.body).toEqual({ meta: {}, blocks: [] });
    const settings = await readPublished('staging', 'site.settings');
    expect(settings?.body).toMatchObject({ name: 'Nuovo sito', lang: 'it' });
  });

  it('returns only published pages', async () => {
    expect(await readPublished('prod', 'site.pages.bozza')).toBeNull();
    expect(await readPublished('staging', 'site.pages.chi-siamo')).toBeNull();
    const pages = await listPublishedPages('prod');
    expect(pages.map((p) => p.path)).toEqual(['site.pages.chi-siamo', 'site.pages.index']);
  });

  it('cannot read the versions table directly', async () => {
    const url = process.env.CORE_DATABASE_URL!;
    const client = (await import('postgres')).default(url, { max: 1 });
    await expect(client`SELECT 1 FROM content_versions`).rejects.toThrow(/permission denied/);
    await client.end();
  });

  it('hides soft-deleted nodes', async () => {
    await database.db
      .update(schema.nodes)
      .set({ deletedAt: new Date() })
      .where(eq(schema.nodes.name, 'chi-siamo'));
    expect(await readPublished('prod', 'site.pages.chi-siamo')).toBeNull();
  });

  it('wraps connection failures', async () => {
    await closeContentDb();
    process.env.CORE_DATABASE_URL = 'postgres://nobody:x@127.0.0.1:1/none';
    await expect(readPublished('prod', 'site.pages.index')).rejects.toBeInstanceOf(
      ContentUnavailableError,
    );
    await closeContentDb();
  });
});
