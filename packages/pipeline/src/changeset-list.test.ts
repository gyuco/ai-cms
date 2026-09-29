import { ROOT_UID, schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listOpenChangesets } from './changeset-list.ts';

describe.skipIf(!testDatabaseUrl)('the open changesets', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async () => 'x' });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('lists only the changesets still being worked on, newest first, with their author', async () => {
    const make = (name: string, status: 'draft' | 'ready' | 'released' | 'closed') =>
      database.db.insert(schema.changesets).values({
        title: name,
        branch: `cs/${name}`,
        baseCommit: 'base',
        authorUid: ROOT_UID,
        status,
        destructiveMigration: name === 'pronto',
      });
    await make('bozza', 'draft');
    await make('pronto', 'ready');
    await make('pubblicato', 'released');
    await make('chiuso', 'closed');

    const list = await listOpenChangesets(database.db);

    expect(list.map((c) => c.title).sort()).toEqual(['bozza', 'pronto']);
    const ready = list.find((c) => c.title === 'pronto')!;
    expect(ready.status).toBe('ready');
    expect(ready.destructiveMigration).toBe(true);
    expect(ready.author?.uid).toBe(ROOT_UID);
    expect(list[0]!.updatedAt >= list[1]!.updatedAt).toBe(true);
  });
});
