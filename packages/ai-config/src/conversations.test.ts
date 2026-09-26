import { schema } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConversation } from './conversations.ts';

describe.skipIf(!testDatabaseUrl)('getConversation', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let uid: number;

  beforeAll(async () => {
    database = await createTestDatabase();
    const [user] = await database.db
      .insert(schema.users)
      .values({ username: 'elena', email: 'elena@example.com', status: 'active' })
      .returning();
    uid = user!.uid;
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('returns null for an unknown id', async () => {
    expect(await getConversation(database.db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('returns the conversation with its messages in order', async () => {
    const [conversation] = await database.db
      .insert(schema.conversations)
      .values({ uid, agent: 'content-agent', env: 'prod', title: 'Nuova pagina "Chi siamo"' })
      .returning();
    const id = conversation!.id;
    await database.db.insert(schema.messages).values([
      { conversationId: id, role: 'user', content: [{ type: 'text', text: 'Crea una pagina' }] },
      {
        conversationId: id,
        role: 'assistant',
        content: [{ type: 'text', text: 'Fatto, ecco la pagina.' }],
      },
    ]);

    const result = await getConversation(database.db, id);
    expect(result).toMatchObject({
      id,
      uid,
      agent: 'content-agent',
      env: 'prod',
      title: 'Nuova pagina "Chi siamo"',
      nodeId: null,
    });
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result!.messages[0]!.content).toEqual([{ type: 'text', text: 'Crea una pagina' }]);
    expect(result!.messages[0]!.id).toBeLessThan(result!.messages[1]!.id);
  });
});
