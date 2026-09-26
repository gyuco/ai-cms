import type { ChatEvent, ChatRequest } from '@ai-cms/ai';
import { schema } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { desc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueAgentSession } from './agent-sessions.ts';
import { createGateway, type Gateway } from './gateway.ts';
import { handleInternalChat, type InternalChatBody } from './internal-chat.ts';
import { AI_ROLES } from './roles.ts';

const masterKey = 'test-master-key-0123456789';

const events: ChatEvent[] = [
  { type: 'text_delta', text: 'Ciao' },
  { type: 'tool_call', id: 't1', name: 'read_node', input: { path: '/site' } },
  { type: 'usage', inputTokens: 10, outputTokens: 5 },
  { type: 'done', stopReason: 'tool_use' },
];

const body: InternalChatBody = {
  role: 'content-agent',
  request: {
    system: 'Sei un agente.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Ciao' }] }],
    tools: [{ name: 'read_node', description: 'Legge un nodo', inputSchema: { type: 'object' } }],
    maxOutputTokens: 100,
  },
};

function post(token: string | null, payload: unknown): Request {
  return new Request('http://cms-api:3100/_cms/internal/ai/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

describe.skipIf(!testDatabaseUrl)('internal chat endpoint', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let gateway: Gateway;
  let uid: number;
  let conversationId: string;
  const seen: ChatRequest[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    const [user] = await database.db
      .insert(schema.users)
      .values({ username: 'elena', email: 'elena@example.com', status: 'active' })
      .returning();
    uid = user!.uid;
    const [conversation] = await database.db
      .insert(schema.conversations)
      .values({ uid, agent: 'content-agent', env: 'prod' })
      .returning();
    conversationId = conversation!.id;
    await database.db.insert(schema.aiConnections).values({
      id: 'ollama',
      label: 'Ollama',
      type: 'local',
      provider: 'openai-compatible',
      baseUrl: 'http://ollama:11434/v1',
      defaultModel: 'qwen3',
    });
    await database.db
      .insert(schema.aiRoles)
      .values(AI_ROLES.map((role) => ({ role, connectionId: 'ollama', model: 'qwen3' })));
    gateway = createGateway(database.db, {
      masterKey,
      createEngine: () => ({
        provider: 'openai-compatible',
        capabilities: async () => ({ tools: true, vision: false, streaming: true }),
        async *stream(req) {
          seen.push(req);
          yield* events;
        },
      }),
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  const call = (request: Request) => handleInternalChat(request, { db: database.db, gateway });

  it('streams ChatEvents as NDJSON and records usage for the session', async () => {
    const { token } = await issueAgentSession(database.db, {
      uid,
      agent: 'content-agent',
      env: 'prod',
      conversationId,
      ttlMs: 60_000,
    });
    const response = await call(post(token, { ...body, request: { ...body.request } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await response.text()).trim().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual(events);

    expect(seen.at(-1)).toMatchObject({
      model: 'qwen3',
      system: 'Sei un agente.',
      maxOutputTokens: 100,
      tools: body.request.tools,
    });
    const [usage] = await database.db
      .select()
      .from(schema.aiUsage)
      .orderBy(desc(schema.aiUsage.id))
      .limit(1);
    expect(usage).toMatchObject({
      uid,
      role: 'content-agent',
      connection: 'ollama',
      model: 'qwen3',
      kind: 'local',
      inputTokens: 10,
      outputTokens: 5,
      outcome: 'ok',
      conversationId,
    });
  });

  it('rejects missing, invalid and expired tokens', async () => {
    expect((await call(post(null, body))).status).toBe(401);
    expect((await call(post('forged', body))).status).toBe(401);
    const { token } = await issueAgentSession(database.db, {
      uid,
      agent: 'content-agent',
      env: 'prod',
      ttlMs: -1,
    });
    const response = await call(post(token, body));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('validates the body and the role', async () => {
    const { token } = await issueAgentSession(database.db, {
      uid,
      agent: 'content-agent',
      env: 'prod',
      ttlMs: 60_000,
    });
    expect((await call(post(token, { request: { messages: 'x' } }))).status).toBe(400);
    const wrongRole = await call(post(token, { ...body, role: 'dev-agent' }));
    expect(wrongRole.status).toBe(403);
    // Non-agent roles are allowed; the role defaults to the session's agent.
    expect((await call(post(token, { ...body, role: 'translate' }))).status).toBe(200);
    const { role: _role, ...withoutRole } = body;
    void _role;
    const response = await call(post(token, withoutRole));
    expect(response.status).toBe(200);
    await response.text();
  });

  it('reports gateway errors as JSON', async () => {
    await database.db.delete(schema.aiRoles);
    const { token } = await issueAgentSession(database.db, {
      uid,
      agent: 'dev-agent',
      env: 'staging',
      ttlMs: 60_000,
    });
    const response = await call(post(token, { request: body.request }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'no_connection' } });
  });
});
