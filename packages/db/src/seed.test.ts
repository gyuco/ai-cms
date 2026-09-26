import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentVersions, nodes, users } from './schema/index.ts';
import { ROOT_UID, seed } from './seed.ts';
import { createTestDatabase, testDatabaseUrl } from './testing.ts';

const fakeHash = async (password: string) => `hash:${password}`;

describe.skipIf(!testDatabaseUrl)('seed', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('creates root with a one-time password, the base tree and a blank home page', async () => {
    const passwords: string[] = [];
    const result = await seed(database.db, {
      hashPassword: fakeHash,
      onRootPassword: (p) => passwords.push(p),
    });
    expect(result.rootCreated).toBe(true);
    expect(passwords).toHaveLength(1);

    const [root] = await database.db.select().from(users).where(eq(users.uid, ROOT_UID));
    expect(root?.passwordHash).toBe(`hash:${passwords[0]}`);
    expect(root?.mustChangePassword).toBe(true);

    const rows = await database.sql`
      SELECT body FROM published_content WHERE path = 'site.pages.index' AND env = 'prod'`;
    expect(rows[0]?.body).toEqual({ meta: {}, blocks: [] });
  });

  it('is idempotent and never prints the password again', async () => {
    const before = await database.db.select({ n: sql<number>`count(*)::int` }).from(nodes);
    const passwords: string[] = [];
    const result = await seed(database.db, {
      hashPassword: fakeHash,
      onRootPassword: (p) => passwords.push(p),
    });
    expect(result).toEqual({ rootCreated: false, nodesCreated: 0 });
    expect(passwords).toEqual([]);
    const after = await database.db.select({ n: sql<number>`count(*)::int` }).from(nodes);
    expect(after).toEqual(before);
    const versions = await database.db.select().from(contentVersions);
    expect(versions).toHaveLength(4);
  });

  it('assigns regular users uids from 1000 after seeding system users', async () => {
    const [user] = await database.db
      .insert(users)
      .values({ username: 'anna', email: 'anna@example.com' })
      .returning();
    expect(user?.uid).toBe(1000);
  });
});
