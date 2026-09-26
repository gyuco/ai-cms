import type { ChatEvent, ChatRequest } from '@ai-cms/ai';
import { AuthzError, devAgentProfile, type Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnection,
  deleteConnection,
  listConnections,
  listRoleAssignments,
  setActiveConnection,
  updateConnection,
} from './connections.ts';
import { createGateway, type Gateway } from './gateway.ts';
import { AI_ROLES, getRoleAssignment } from './roles.ts';
import { readSecretValue } from './secrets.ts';
import { testConnection } from './test-connection.ts';

const masterKey = 'test-master-key-0123456789';
const options = { masterKey };
const apiKey = 'sk-ant-api03-connection-test-a1b2';

describe.skipIf(!testDatabaseUrl)('AI connections and roles', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let user: Principal;
  let other: Principal;
  // What the fake provider does on the next call(s).
  let script: (req: ChatRequest) => ChatEvent[] = () => [];
  let gateway: Gateway;

  beforeAll(async () => {
    database = await createTestDatabase();
    const rows = await database.db
      .insert(schema.users)
      .values([
        { username: 'franca', email: 'franca@example.com', status: 'active' },
        { username: 'gino', email: 'gino@example.com', status: 'active' },
      ])
      .returning();
    user = { uid: rows[0]!.uid, username: 'franca', status: 'active' };
    other = { uid: rows[1]!.uid, username: 'gino', status: 'active' };
    gateway = createGateway(database.db, {
      masterKey,
      createEngine: () => ({
        provider: 'openai-compatible',
        capabilities: async () => ({ tools: true, vision: false, streaming: true }),
        async *stream(req) {
          yield* script(req);
        },
      }),
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('creates connections and never returns the key', async () => {
    const view = await createConnection(
      database.db,
      user,
      {
        id: 'anthropic',
        label: 'Anthropic',
        type: 'api',
        provider: 'anthropic',
        defaultModel: 'claude-opus-5',
        apiKey,
      },
      options,
    );
    expect(view).toMatchObject({
      id: 'anthropic',
      scope: 'shared',
      hasKey: true,
      keyHint: '…a1b2',
      lastTest: null,
    });
    expect(JSON.stringify(view)).not.toContain('connection-test');
    expect(await readSecretValue(database.db, 'ai/anthropic', options)).toBe(apiKey);

    const local = await createConnection(
      database.db,
      user,
      {
        label: 'Ollama',
        type: 'local',
        provider: 'openai-compatible',
        baseUrl: 'http://ollama:11434/v1',
        defaultModel: 'tinymodel',
      },
      options,
    );
    expect(local.id).toMatch(/^openai-compatible-[0-9a-f]{6}$/);
    expect(local).toMatchObject({ hasKey: false, keyHint: null });

    await createConnection(
      database.db,
      user,
      { id: 'claude-sub', label: 'Claude Code', type: 'subscription', provider: 'claude-code' },
      options,
    );
    await createConnection(
      database.db,
      other,
      {
        id: 'gino-local',
        label: 'Locale di Gino',
        type: 'local',
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:1234/v1',
        scope: 'personal',
      },
      options,
    );

    const list = await listConnections(database.db, user);
    expect(list.map((c) => c.id)).toEqual(['anthropic', local.id, 'claude-sub']);
    expect(JSON.stringify(list)).not.toContain('connection-test');
    expect((await listConnections(database.db, other)).map((c) => c.id)).toContain('gino-local');
  });

  it('validates the shape of a connection', async () => {
    const bad = [
      { label: 'x', type: 'api', provider: 'anthropic' },
      { label: 'x', type: 'api', provider: 'openai-compatible', apiKey: 'k' },
      { label: 'x', type: 'subscription', provider: 'anthropic' },
      { label: 'x', type: 'local', provider: 'openai-compatible', baseUrl: 'ftp://x' },
      { id: 'Bad Id', label: 'x', type: 'subscription', provider: 'claude-code' },
    ] as const;
    for (const input of bad) {
      await expect(createConnection(database.db, user, input, options)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    await expect(
      createConnection(
        database.db,
        user,
        { id: 'claude-sub', label: 'x', type: 'subscription', provider: 'claude-code' },
        options,
      ),
    ).rejects.toMatchObject({ code: 'exists' });
  });

  it('updates label, model and key', async () => {
    const view = await updateConnection(
      database.db,
      user,
      'anthropic',
      { label: 'Anthropic (azienda)', apiKey: 'sk-ant-api03-rotated-key-zz99' },
      options,
    );
    expect(view).toMatchObject({ label: 'Anthropic (azienda)', keyHint: '…zz99' });
    expect(await readSecretValue(database.db, 'ai/anthropic', options)).toBe(
      'sk-ant-api03-rotated-key-zz99',
    );
    await expect(
      updateConnection(database.db, user, 'anthropic', { apiKey: null }, options),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      updateConnection(database.db, user, 'gino-local', { label: 'mia' }, options),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('sets one active connection for every role, refusing models without tools', async () => {
    await expect(
      setActiveConnection(database.db, user, 'anthropic', 'mystery-model'),
    ).rejects.toMatchObject({ code: 'model_without_tools' });
    await expect(
      setActiveConnection(database.db, user, 'gino-local', 'qwen3'),
    ).rejects.toMatchObject({ code: 'personal_connection' });

    const result = await setActiveConnection(database.db, user, 'anthropic');
    expect(result).toEqual({
      connectionId: 'anthropic',
      model: 'claude-opus-5',
      roles: [...AI_ROLES],
    });
    for (const role of AI_ROLES) {
      const assignment = await getRoleAssignment(database.db, role);
      expect(assignment).toMatchObject({ model: 'claude-opus-5' });
      expect(assignment!.connection.id).toBe('anthropic');
    }
    expect(await listRoleAssignments(database.db, user)).toHaveLength(AI_ROLES.length);

    await setActiveConnection(database.db, user, 'claude-sub');
    expect((await getRoleAssignment(database.db, 'dev-agent'))!.connection.id).toBe('claude-sub');
  });

  it('refuses to delete the active connection, deletes the others with their key', async () => {
    await expect(deleteConnection(database.db, user, 'claude-sub')).rejects.toMatchObject({
      code: 'in_use',
    });
    await setActiveConnection(database.db, user, 'anthropic');
    await deleteConnection(database.db, user, 'claude-sub');
    const [row] = await database.db
      .select()
      .from(schema.aiConnections)
      .where(eq(schema.aiConnections.id, 'claude-sub'));
    expect(row).toBeUndefined();
  });

  it('refuses agents (invariant I4)', async () => {
    const agent: Principal = { ...user, agent: devAgentProfile };
    await expect(
      setActiveConnection(database.db, agent, 'anthropic', 'claude-opus-5'),
    ).rejects.toBeInstanceOf(AuthzError);
    await expect(
      createConnection(
        database.db,
        agent,
        { label: 'x', type: 'local', provider: 'openai-compatible', baseUrl: 'http://x' },
        options,
      ),
    ).rejects.toMatchObject({ code: 'invariant-I4' });
    await expect(deleteConnection(database.db, agent, 'anthropic')).rejects.toBeInstanceOf(
      AuthzError,
    );
  });

  describe('testConnection', () => {
    let localId: string;

    beforeAll(async () => {
      const list = await listConnections(database.db, user);
      localId = list.find((c) => c.type === 'local')!.id;
    });

    it('reports tool support when the model calls the probe tool', async () => {
      script = (req) => [
        {
          type: 'tool_call',
          id: 'c1',
          name: req.tools[0]!.name,
          input: { status: 'ok' },
        },
        { type: 'usage', inputTokens: 20, outputTokens: 5 },
        { type: 'done', stopReason: 'tool_use' },
      ];
      const result = await testConnection(database.db, user, gateway, 'anthropic');
      expect(result).toMatchObject({ ok: true, status: 'ok', model: 'claude-opus-5', tools: true });
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      const [usage] = await database.db.select().from(schema.aiUsage);
      expect(usage).toMatchObject({ role: 'connection-test', connection: 'anthropic' });
    });

    it('lets a tested local model be assigned even if the table does not know it', async () => {
      await expect(setActiveConnection(database.db, user, localId)).rejects.toMatchObject({
        code: 'model_without_tools',
      });
      await testConnection(database.db, user, gateway, localId);
      const view = (await listConnections(database.db, user)).find((c) => c.id === localId);
      expect(view!.lastTest).toMatchObject({ model: 'tinymodel', ok: true, tools: true });
      await expect(setActiveConnection(database.db, user, localId)).resolves.toMatchObject({
        model: 'tinymodel',
      });
      await setActiveConnection(database.db, user, 'anthropic');
    });

    it('detects models without tool calling', async () => {
      script = (req) =>
        req.tools.length > 0
          ? [
              { type: 'error', message: 'tinymodel does not support tools', status: 400 },
              { type: 'done', stopReason: 'error' },
            ]
          : [
              { type: 'text_delta', text: 'ok' },
              { type: 'done', stopReason: 'end_turn' },
            ];
      const result = await testConnection(database.db, user, gateway, localId);
      expect(result).toMatchObject({ ok: true, tools: false });
      expect(result.message).toContain('non supporta');
      await expect(setActiveConnection(database.db, user, localId)).rejects.toMatchObject({
        code: 'model_without_tools',
      });

      script = () => [
        { type: 'text_delta', text: 'Ciao!' },
        { type: 'done', stopReason: 'end_turn' },
      ];
      expect(await testConnection(database.db, user, gateway, localId)).toMatchObject({
        ok: true,
        tools: false,
      });
    });

    it('explains provider errors in Italian', async () => {
      script = () => [
        { type: 'error', message: 'invalid x-api-key', status: 401 },
        { type: 'done', stopReason: 'error' },
      ];
      const result = await testConnection(database.db, user, gateway, 'anthropic');
      expect(result).toMatchObject({ ok: false, status: 'error', tools: false });
      expect(result.message).toContain('chiave API');
    });

    it('leaves Claude Code to the agent-runner', async () => {
      await createConnection(
        database.db,
        user,
        { id: 'claude-sub2', label: 'Claude Code', type: 'subscription', provider: 'claude-code' },
        options,
      );
      expect(await testConnection(database.db, user, gateway, 'claude-sub2')).toMatchObject({
        ok: false,
        status: 'unverified',
        message: expect.stringContaining('agent-runner'),
      });
    });
  });
});
