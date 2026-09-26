import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, testDatabaseUrl } from '../testing.ts';
import { contentVersions, publications } from './content.ts';
import { users } from './identity.ts';
import { nodes } from './tree.ts';

describe.skipIf(!testDatabaseUrl)('content schema', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
    const [user] = await database.db
      .insert(users)
      .values({ username: 'root', email: 'root@localhost' })
      .returning();
    const [page] = await database.db
      .insert(nodes)
      .values({ name: '', path: '', kind: 'page', createdBy: user!.uid })
      .returning();
    const [draft, published] = await database.db
      .insert(contentVersions)
      .values([
        { nodeId: page!.id, env: 'prod', version: 1, body: { title: 'v1' }, authorUid: user!.uid },
        { nodeId: page!.id, env: 'prod', version: 2, body: { title: 'v2' }, authorUid: user!.uid },
      ])
      .returning();
    expect(draft).toBeDefined();
    await database.db.insert(publications).values({
      nodeId: page!.id,
      env: 'prod',
      versionId: published!.id,
      status: 'published',
      publishedBy: user!.uid,
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('exposes only the published version to the site reader role', async () => {
    const rows = await database.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE cms_content_ro`;
      return tx`SELECT body, version FROM published_content WHERE env = 'prod'`;
    });
    expect(rows).toEqual([{ body: { title: 'v2' }, version: 2 }]);
  });

  it('denies the site reader role direct access to the tables', async () => {
    await expect(
      database.sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE cms_content_ro`;
        await tx`SELECT * FROM content_versions`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
