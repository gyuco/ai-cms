import { randomBytes, randomUUID } from 'node:crypto';
import { testDatabaseUrl } from '@ai-cms/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changesetDatabaseName,
  createChangesetDatabase,
  dropChangesetDatabase,
} from './changeset-db.ts';

describe('changesetDatabaseName', () => {
  it('derives a safe name from the changeset id', () => {
    expect(changesetDatabaseName('0b5c7a4e-9d1f-4c3a-8e2b-1f2a3b4c5d6e')).toBe(
      'app_cs_0b5c7a4e9d1f4c3a8e2b1f2a3b4c5d6e',
    );
    expect(() => changesetDatabaseName('x"; DROP DATABASE app_prod; --')).toThrow(/non valido/);
  });
});

describe.skipIf(!testDatabaseUrl)('changeset databases', () => {
  const template = `tpl_${randomBytes(6).toString('hex')}`;
  const urlFor = (database: string) => {
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${database}`;
    return url.toString();
  };
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${template}`);
    const tpl = postgres(urlFor(template), { max: 1 });
    await tpl`CREATE TABLE prodotti (id serial PRIMARY KEY, nome text NOT NULL)`;
    await tpl`INSERT INTO prodotti (nome) VALUES ('Tavolo')`;
    await tpl.end();
  });

  afterAll(async () => {
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
    await admin?.end();
  });

  it('clones the template and drops the clone', async () => {
    const id = randomUUID();
    const name = await createChangesetDatabase(testDatabaseUrl!, id, { template });
    expect(name).toBe(changesetDatabaseName(id));
    // Idempotent.
    await createChangesetDatabase(testDatabaseUrl!, id, { template });

    const clone = postgres(urlFor(name), { max: 1 });
    expect(await clone`SELECT nome FROM prodotti`).toEqual([{ nome: 'Tavolo' }]);
    await clone.end();

    await dropChangesetDatabase(testDatabaseUrl!, id);
    await dropChangesetDatabase(testDatabaseUrl!, id);
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    expect(rows).toHaveLength(0);
  });

  // Postgres itself waits about 5 seconds for the template's connections before failing.
  it('retries, then fails clearly while the template has open connections', async () => {
    const busy = postgres(urlFor(template), { max: 1 });
    await busy`SELECT 1`;
    const id = randomUUID();
    try {
      await expect(
        createChangesetDatabase(testDatabaseUrl!, id, { template, attempts: 2, retryDelayMs: 20 }),
      ).rejects.toThrow(/connessioni aperte/);
    } finally {
      await busy.end();
    }
    const rows =
      await admin`SELECT 1 FROM pg_database WHERE datname = ${changesetDatabaseName(id)}`;
    expect(rows).toHaveLength(0);
  }, 30_000);
});
