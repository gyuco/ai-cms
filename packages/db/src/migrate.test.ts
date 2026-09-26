import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, testDatabaseUrl } from './testing.ts';

describe.skipIf(!testDatabaseUrl)('migrations', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('apply cleanly to an empty database', async () => {
    const [row] = await database.sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    expect(row?.n).toBeGreaterThan(0);
  });
});
