import { AuthzError, contentAgentProfile, type Principal } from '@ai-cms/authz';
import { ConflictError } from '@ai-cms/tree';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { whoamiTool } from './examples.ts';
import { createToolRegistry, defineCmsTool } from './registry.ts';
import { createMcpHandler, type ToolCallRecord } from './server.ts';

const principal: Principal = {
  uid: 7,
  username: 'mario',
  status: 'active',
  agent: contentAgentProfile,
};

const forbidden = defineCmsTool({
  name: 'forbidden',
  description: 'Always denied',
  input: z.object({}),
  run: () => {
    throw new AuthzError({
      allowed: false,
      code: 'invariant-I1',
      message: 'Nessun agente può modificare /system/secrets.',
      steps: [],
    });
  },
});

const add = defineCmsTool({
  name: 'add',
  description: 'Adds two numbers',
  input: z.object({ a: z.number(), b: z.number() }),
  run: ({ a, b }) => a + b,
});

const conflicted = defineCmsTool({
  name: 'conflicted',
  description: 'Always conflicts',
  input: z.object({}),
  run: () => {
    throw new ConflictError({
      path: '/site/pages/chi-siamo',
      expectedVersion: 2,
      currentVersion: 3,
    });
  },
});

const broken = defineCmsTool({
  name: 'broken',
  description: 'Fails unexpectedly',
  input: z.object({}),
  run: () => {
    throw new Error('connessione persa');
  },
});

function setup() {
  const registry = createToolRegistry();
  for (const tool of [whoamiTool, forbidden, add, broken, conflicted]) registry.register(tool);
  const records: ToolCallRecord[] = [];
  const handler = createMcpHandler({
    registry,
    resolvePrincipal: async (token) => (token === 'good-token' ? principal : null),
    createContext: (p) => ({ principal: p, env: 'staging' }),
    onToolCall: (record) => {
      records.push(record);
    },
  });
  return { handler, records };
}

let nextId = 1;

function rpc(method: string, params: unknown, token: string | null = 'good-token'): Request {
  return new Request('http://cms-api/_cms/internal/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
}

async function callTool(handler: (r: Request) => Promise<Response>, name: string, args = {}) {
  const res = await handler(rpc('tools/call', { name, arguments: args }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { content: { type: string; text: string }[]; isError?: boolean };
  };
  return body.result;
}

describe('MCP handler', () => {
  it('answers initialize', async () => {
    const { handler } = setup();
    const res = await handler(
      rpc('initialize', {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result).toMatchObject({
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'ai-cms' },
    });
  });

  it('lists the registered tools with their JSON Schema', async () => {
    const { handler } = setup();
    const res = await handler(rpc('tools/list', {}));
    const body = (await res.json()) as { result: { tools: Record<string, unknown>[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual([
      'whoami',
      'forbidden',
      'add',
      'broken',
      'conflicted',
    ]);
    expect(body.result.tools[2]).toMatchObject({
      name: 'add',
      description: 'Adds two numbers',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    });
  });

  it('runs a tool with the principal and environment of the session', async () => {
    const { handler, records } = setup();
    const result = await callTool(handler, 'whoami');
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      username: 'mario',
      agent: 'content-agent',
      env: 'staging',
      scope: null,
    });
    expect(records).toMatchObject([{ tool: 'whoami', isError: false, principal }]);
  });

  it('turns AuthzError into a readable error result', async () => {
    const { handler, records } = setup();
    const result = await callTool(handler, 'forbidden');
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'Permesso negato: Nessun agente può modificare /system/secrets.' },
      ],
      isError: true,
    });
    expect(records[0]).toMatchObject({ tool: 'forbidden', isError: true });
  });

  it('turns ConflictError into a merge proposal instead of a bare retry (FR-64)', async () => {
    const { handler, records } = setup();
    const result = await callTool(handler, 'conflicted');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(
      '/site/pages/chi-siamo è stato modificato da qualcun altro',
    );
    expect(result.content[0]!.text).toContain("proponi all'utente un'unione");
    expect(records[0]).toMatchObject({ tool: 'conflicted', isError: true });
  });

  it('reports invalid input, unknown tools and unexpected failures without crashing', async () => {
    const { handler } = setup();
    const invalid = await callTool(handler, 'add', { a: 1, b: 'due' });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]!.text).toMatch(/^Input non valido per add/);
    const unknown = await callTool(handler, 'nope');
    expect(unknown).toMatchObject({
      isError: true,
      content: [{ text: 'Strumento sconosciuto: nope' }],
    });
    const failed = await callTool(handler, 'broken');
    expect(failed).toMatchObject({
      isError: true,
      content: [{ text: 'Errore: connessione persa' }],
    });
    // The same handler keeps serving requests.
    expect((await callTool(handler, 'add', { a: 1, b: 2 })).content[0]!.text).toBe('3');
  });

  it('rejects requests without a valid token', async () => {
    const { handler } = setup();
    for (const token of [null, 'bad-token']) {
      const res = await handler(rpc('tools/list', {}, token));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(await res.json()).toMatchObject({
        error: { message: 'Token di sessione mancante o non valido.' },
      });
    }
  });

  it('does not run tools for rejected tokens', async () => {
    const run = vi.fn(() => 'ok');
    const registry = createToolRegistry();
    registry.register(defineCmsTool({ name: 'spy', description: '', input: z.object({}), run }));
    const handler = createMcpHandler({
      registry,
      resolvePrincipal: async () => null,
      createContext: (p) => ({ principal: p, env: 'prod' }),
    });
    const res = await handler(rpc('tools/call', { name: 'spy', arguments: {} }));
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses GET since the server is stateless', async () => {
    const { handler } = setup();
    const res = await handler(
      new Request('http://cms-api/_cms/internal/mcp', {
        headers: { authorization: 'Bearer good-token', accept: 'text/event-stream' },
      }),
    );
    expect(res.status).toBe(405);
  });
});

describe('tool registry', () => {
  it('rejects duplicate names', () => {
    const registry = createToolRegistry();
    registry.register(whoamiTool);
    expect(() => registry.register(whoamiTool)).toThrow(/already registered/);
  });

  it('binds tools to a session for the native agent loop', async () => {
    const registry = createToolRegistry();
    registry.register(whoamiTool);
    registry.register(forbidden);
    const [whoami, denied] = registry.bind({ principal, env: 'prod' });
    expect(await whoami!.run({}, { toolCallId: 'c1' })).toMatchObject({
      username: 'mario',
      env: 'prod',
    });
    await expect(denied!.run({}, { toolCallId: 'c2' })).rejects.toThrow(/^Permesso negato: /);
  });
});
