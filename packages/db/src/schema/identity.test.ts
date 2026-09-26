import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, testDatabaseUrl } from '../testing.ts';
import { users } from './identity.ts';

describe.skipIf(!testDatabaseUrl)('identity schema', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('assigns uids from 1000 and keeps usernames unique case-insensitively', async () => {
    const [user] = await database.db
      .insert(users)
      .values({ username: 'Mario', email: 'mario@example.com' })
      .returning();
    expect(user?.uid).toBe(1000);
    expect(user?.status).toBe('invited');

    await expect(
      database.db.insert(users).values({ username: 'mario', email: 'other@example.com' }),
    ).rejects.toThrow();
  });

  it('rejects unknown statuses', async () => {
    await expect(
      database.sql`INSERT INTO users (username, email, status) VALUES ('x', 'x@example.com', 'bogus')`,
    ).rejects.toThrow(/users_status_check/);
  });
});
