import { schema } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendMessages,
  createConversation,
  getConversation,
  getOwnConversation,
  listNodeConversations,
} from './conversations.ts';

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

describe.skipIf(!testDatabaseUrl)('conversations of a page', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let uid: number;
  let other: number;
  let nodeId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const users = await database.db
      .insert(schema.users)
      .values([
        { username: 'elena', email: 'elena@example.com', status: 'active' },
        { username: 'marco', email: 'marco@example.com', status: 'active' },
      ])
      .returning();
    uid = users[0]!.uid;
    other = users[1]!.uid;
    const [node] = await database.db
      .insert(schema.nodes)
      .values({ path: 'site', name: '', kind: 'dir', env: 'prod', createdBy: uid })
      .returning();
    nodeId = node!.id;
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('lists only the own conversations of the node in the environment, newest first', async () => {
    const first = await createConversation(database.db, {
      uid,
      env: 'prod',
      agent: 'content-agent',
      nodeId,
      title: 'Prima',
    });
    const second = await createConversation(database.db, {
      uid,
      env: 'prod',
      agent: 'content-agent',
      nodeId,
      title: 'Seconda',
    });
    await createConversation(database.db, {
      uid: other,
      env: 'prod',
      agent: 'content-agent',
      nodeId,
      title: 'Di Marco',
    });
    await createConversation(database.db, {
      uid,
      env: 'staging',
      agent: 'content-agent',
      nodeId,
      title: 'In staging',
    });
    await appendMessages(database.db, first, [
      { role: 'user', content: [{ type: 'text', text: 'Ciao' }] },
    ]);

    const list = await listNodeConversations(database.db, { uid, env: 'prod' }, nodeId);
    expect(list.map((c) => c.id)).toEqual([first, second]);
  });

  it('hides the conversations of other users and environments', async () => {
    const id = await createConversation(database.db, {
      uid,
      env: 'prod',
      agent: 'content-agent',
      nodeId: null,
      title: null,
    });
    expect(await getOwnConversation(database.db, id, { uid, env: 'prod' })).not.toBeNull();
    expect(await getOwnConversation(database.db, id, { uid: other, env: 'prod' })).toBeNull();
    expect(await getOwnConversation(database.db, id, { uid, env: 'staging' })).toBeNull();
  });

  it('appends messages in order', async () => {
    const id = await createConversation(database.db, {
      uid,
      env: 'prod',
      agent: 'content-agent',
      nodeId: null,
      title: null,
    });
    await appendMessages(database.db, id, [
      { role: 'user', content: [{ type: 'text', text: 'uno' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'due' }] },
    ]);
    const conversation = await getConversation(database.db, id);
    expect(conversation?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});
