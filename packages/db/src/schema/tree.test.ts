import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, testDatabaseUrl } from '../testing.ts';
import { users } from './identity.ts';
import { nodes } from './tree.ts';

describe.skipIf(!testDatabaseUrl)('tree schema', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let uid: number;

  beforeAll(async () => {
    database = await createTestDatabase();
    const [user] = await database.db
      .insert(users)
      .values({ username: 'root', email: 'root@localhost' })
      .returning();
    uid = user!.uid;
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('stores a hierarchy and finds ancestors with ltree', async () => {
    const [root] = await database.db
      .insert(nodes)
      .values({ name: '', path: '', kind: 'dir', createdBy: uid })
      .returning();
    const [site] = await database.db
      .insert(nodes)
      .values({ parentId: root!.id, name: 'site', path: 'site', kind: 'dir', createdBy: uid })
      .returning();
    await database.db.insert(nodes).values({
      parentId: site!.id,
      name: 'chi-siamo',
      path: 'site.chi-siamo',
      kind: 'page',
      createdBy: uid,
    });

    const ancestors = await database.db
      .select({ path: nodes.path })
      .from(nodes)
      .where(sql`${nodes.path} @> 'site.chi-siamo'::ltree`)
      .orderBy(sql`nlevel(${nodes.path})`);
    expect(ancestors.map((n) => n.path)).toEqual(['', 'site', 'site.chi-siamo']);
  });

  it('rejects invalid names and duplicate live paths', async () => {
    await expect(
      database.db
        .insert(nodes)
        .values({ name: 'Bad Name', path: 'x', kind: 'dir', createdBy: uid }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(nodes).values({ name: 'site', path: 'site', kind: 'dir', createdBy: uid }),
    ).rejects.toThrow();
  });

  it('allows reusing a path once the old node is deleted', async () => {
    await database.sql`UPDATE nodes SET deleted_at = now() WHERE path = 'site.chi-siamo'`;
    const [site] = await database.db
      .select()
      .from(nodes)
      .where(sql`${nodes.path} = 'site'`);
    await database.db.insert(nodes).values({
      parentId: site!.id,
      name: 'chi-siamo',
      path: 'site.chi-siamo',
      kind: 'page',
      createdBy: uid,
    });
  });
});
