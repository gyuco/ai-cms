import type { ChatEngine, ChatEvent, ChatRequest } from '@ai-cms/ai';
import type { Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { desc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway, GatewayError, type EngineFactory } from './gateway.ts';
import { AI_ROLES, type AiConnection } from './roles.ts';
import { setSecret } from './secrets.ts';

const masterKey = 'test-master-key-0123456789';

function fakeEngine(events: ChatEvent[], seen: ChatRequest[] = []): ChatEngine {
  return {
    provider: 'anthropic',
    capabilities: async () => ({ tools: true, vision: true, streaming: true }),
    async *stream(req) {
      seen.push(req);
      yield* events;
    },
  };
}

const okEvents: ChatEvent[] = [
  { type: 'text_delta', text: 'Ciao' },
  { type: 'usage', inputTokens: 1_000_000, outputTokens: 100_000 },
  { type: 'done', stopReason: 'end_turn' },
];

describe.skipIf(!testDatabaseUrl)('AI gateway', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let user: Principal;
  const built: { connection: AiConnection; apiKey: string | undefined }[] = [];
  let events: ChatEvent[] = okEvents;
  const factory: EngineFactory = (connection, apiKey) => {
    built.push({ connection, apiKey });
    return fakeEngine(events);
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    const [row] = await database.db
      .insert(schema.users)
      .values({ username: 'carla', email: 'carla@example.com', status: 'active' })
      .returning();
    user = { uid: row!.uid, username: 'carla', status: 'active' };
    await setSecret(database.db, user, 'ai/anthropic-key', 'sk-ant-api03-gateway-a1b2', {
      masterKey,
    });
    await database.db.insert(schema.aiConnections).values([
      {
        id: 'anthropic-key',
        label: 'Anthropic',
        type: 'api',
        provider: 'anthropic',
        defaultModel: 'claude-opus-5',
        secretName: 'ai/anthropic-key',
      },
      {
        id: 'ollama',
        label: 'Ollama',
        type: 'local',
        provider: 'openai-compatible',
        baseUrl: 'http://ollama:11434/v1',
        defaultModel: 'qwen3',
      },
      { id: 'claude-sub', label: 'Claude Code', type: 'subscription', provider: 'claude-code' },
      {
        id: 'nokey',
        label: 'Senza chiave',
        type: 'api',
        provider: 'anthropic',
        defaultModel: 'claude-opus-5',
      },
    ]);
    await database.db
      .insert(schema.aiRoles)
      .values(AI_ROLES.map((role) => ({ role, connectionId: 'anthropic-key', model: null })));
  });

  afterAll(async () => {
    await database?.drop();
  });

  const lastUsage = async () =>
    (await database.db.select().from(schema.aiUsage).orderBy(desc(schema.aiUsage.id)).limit(1))[0]!;

  it('resolves a role, decrypts the key at call time and records usage', async () => {
    const gateway = createGateway(database.db, { masterKey, createEngine: factory });
    const seen: ChatEvent[] = [];
    for await (const event of gateway.stream(
      { uid: user.uid, role: 'content-agent' },
      { system: '', messages: [], tools: [] },
    )) {
      seen.push(event);
    }
    expect(seen).toEqual(okEvents);
    expect(built.at(-1)!.apiKey).toBe('sk-ant-api03-gateway-a1b2');
    expect(built.at(-1)!.connection.id).toBe('anthropic-key');
    expect(await lastUsage()).toMatchObject({
      uid: user.uid,
      role: 'content-agent',
      connection: 'anthropic-key',
      model: 'claude-opus-5',
      kind: 'api',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      costEstimate: '7.500000',
      outcome: 'ok',
    });
  });

  it('records errors, and early stops as aborted', async () => {
    const gateway = createGateway(database.db, { masterKey, createEngine: factory });
    events = [
      { type: 'error', message: 'overloaded', status: 529, retryable: true },
      { type: 'done', stopReason: 'error' },
    ];
    const { engine, model } = await gateway.open({ uid: user.uid, role: 'translate' });
    for await (const event of engine.stream({ model, system: '', messages: [], tools: [] })) {
      void event;
    }
    expect(await lastUsage()).toMatchObject({ role: 'translate', outcome: 'error' });

    events = okEvents;
    for await (const event of engine.stream({ model, system: '', messages: [], tools: [] })) {
      void event;
      break;
    }
    expect(await lastUsage()).toMatchObject({ outcome: 'aborted', inputTokens: 0 });
  });

  it('uses an explicit connection; local models cost nothing', async () => {
    const gateway = createGateway(database.db, { masterKey, createEngine: factory });
    const { engine, model, role } = await gateway.open({ uid: user.uid, connectionId: 'ollama' });
    expect(model).toBe('qwen3');
    expect(role).toBe('direct');
    expect(built.at(-1)!.apiKey).toBeUndefined();
    for await (const event of engine.stream({ model, system: '', messages: [], tools: [] })) {
      void event;
    }
    expect(await lastUsage()).toMatchObject({
      connection: 'ollama',
      kind: 'local',
      costEstimate: '0.000000',
    });
  });

  it('explains what it cannot do', async () => {
    const gateway = createGateway(database.db, { masterKey, createEngine: factory });
    await expect(gateway.open({ uid: user.uid, connectionId: 'claude-sub' })).rejects.toMatchObject(
      {
        code: 'cli_engine',
        message: expect.stringContaining('motore CLI'),
      },
    );
    await expect(gateway.open({ uid: user.uid, connectionId: 'nokey' })).rejects.toMatchObject({
      code: 'missing_key',
    });
    await expect(gateway.open({ uid: user.uid, connectionId: 'nope' })).rejects.toBeInstanceOf(
      GatewayError,
    );
    await database.db.delete(schema.aiRoles);
    await expect(gateway.open({ uid: user.uid, role: 'dev-agent' })).rejects.toMatchObject({
      code: 'no_connection',
    });
  });

  it('refuses personal connections of other users', async () => {
    const [other] = await database.db
      .insert(schema.users)
      .values({ username: 'dario', email: 'dario@example.com', status: 'active' })
      .returning();
    await database.db.insert(schema.aiConnections).values({
      id: 'dario-local',
      label: 'Locale di Dario',
      type: 'local',
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      defaultModel: 'qwen3',
      ownerUid: other!.uid,
    });
    const gateway = createGateway(database.db, { masterKey, createEngine: factory });
    await expect(
      gateway.open({ uid: user.uid, connectionId: 'dario-local' }),
    ).rejects.toMatchObject({ code: 'personal_connection' });
    await expect(
      gateway.open({ uid: other!.uid, connectionId: 'dario-local' }),
    ).resolves.toBeDefined();
  });
});
