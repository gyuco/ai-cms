import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createDatabase } from './client.ts';
import { runMigrations } from './migrate.ts';

const rolesSql = readFileSync(new URL('../sql/roles.sql', import.meta.url), 'utf8');
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/**
 * Creates an isolated, migrated database for an integration test file.
 * Requires TEST_DATABASE_URL pointing to a server where the user can create databases and roles.
 */
export async function createTestDatabase() {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is not set');
  const name = `test_${randomBytes(6).toString('hex')}`;
  const admin = postgres(testDatabaseUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(rolesSql);
  await admin.unsafe(`CREATE DATABASE ${name}`);

  const url = new URL(testDatabaseUrl);
  url.pathname = `/${name}`;
  const setup = postgres(url.toString(), { max: 1, onnotice: () => {} });
  await setup.unsafe(
    'CREATE EXTENSION IF NOT EXISTS ltree; CREATE EXTENSION IF NOT EXISTS citext;',
  );
  await setup.end();
  await runMigrations(url.toString(), migrationsFolder);

  const database = createDatabase(url.toString(), { max: 5 });
  return {
    url: url.toString(),
    ...database,
    async drop() {
      await database.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
