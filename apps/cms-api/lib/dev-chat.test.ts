import type { ChatStreamEvent } from '@ai-cms/agents';
import { GatewayError, getConversation, resolveAgentSession } from '@ai-cms/ai-config';
import { AuthzError, type Principal } from '@ai-cms/authz';
import { schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  resolveError: undefined as Error | undefined,
}));

vi.mock('./db.ts', () => ({ db: () => state.db }));
vi.mock('./assets.ts', () => ({ assetStorage: async () => undefined }));
vi.mock('./sites.ts', () => ({ revalidateSite: async () => undefined }));
vi.mock('./ai.ts', () => ({
  gateway: () => ({
    async resolve() {
      if (state.resolveError) throw state.resolveError;
      return { connection: { id: 'fake' }, model: 'fake-model', role: 'dev-agent' };
    },
  }),
}));

const {
  approveDevDependencies,
  isDependencyDenial,
  runDevChatTurn,
  startDevChangeset,
  toChatEvent,
} = await import('./dev-chat.ts');

const root: Principal = { uid: 0, username: 'root', status: 'active' };
const staging = { uid: 0, env: 'staging' } as const;

interface Sent {
  body: { token: string; engine: string; prompt: string; messages?: unknown[] };
  session: Awaited<ReturnType<typeof resolveAgentSession>>;
}

describe.skipIf(!testDatabaseUrl)('chat with the developer agent (E10.11)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let script: Record<string, unknown>[] = [];
  let sent: Sent[] = [];

  /** The agent-runner, scripted: reads the request, answers with `script` as NDJSON. */
  const fakeRunner = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Sent['body'];
    sent.push({ body, session: await resolveAgentSession(database.db, body.token) });
    const lines = script.map((event) => `${JSON.stringify(event)}\n`).join('');
    return new Response(lines, { status: 200 });
  }) as typeof fetch;

  beforeAll(async () => {
    database = await createTestDatabase();
    state.db = database.db;
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(() => {
    script = [];
    sent = [];
    state.resolveError = undefined;
  });

  /** A changeset the way the worker leaves it, tied to a chat of the given user. */
  async function openChangeset(status: 'draft' | 'ready' = 'draft', env: 'staging' = 'staging') {
    const { conversationId } = await startDevChangeset(root, env, { title: 'Pagina eventi' });
    const id = randomUUID();
    await database.db.insert(schema.changesets).values({
      id,
      title: 'Pagina eventi',
      branch: `cs/${id}`,
      baseCommit: 'a'.repeat(40),
      authorUid: 0,
      status,
      conversationId,
    });
    return { id, conversationId };
  }

  async function turn(
    changesetId: string,
    message: string,
    who: { uid: number; env: 'prod' | 'staging' } = staging,
  ): Promise<ChatStreamEvent[]> {
    const response = runDevChatTurn(who, { changesetId, message }, new AbortController().signal, {
      fetch: fakeRunner,
      runnerUrl: 'http://runner.test',
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    return text
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.split('\ndata: ')[1]!) as ChatStreamEvent);
  }

  describe('opening a changeset', () => {
    it('opens a chat and asks the worker for the changeset, with an audit entry', async () => {
      const { conversationId, jobId } = await startDevChangeset(root, 'staging', {
        title: '  Calendario eventi ',
      });

      const conversation = await getConversation(database.db, conversationId);
      expect(conversation).toMatchObject({ agent: 'dev-agent', env: 'staging', uid: 0 });
      expect(conversation?.title).toBe('Calendario eventi');
      const [job] = await database.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId!));
      expect(job).toMatchObject({ type: 'changeset.create', status: 'queued' });
      expect(job!.payload).toMatchObject({
        title: 'Calendario eventi',
        authorUid: 0,
        conversationId,
      });
      const audit = await database.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'changeset.request'));
      expect(audit.some((row) => (row.details as { jobId?: number }).jobId === jobId)).toBe(true);
    });

    it('is refused in production by authz, not by the endpoint', async () => {
      await expect(startDevChangeset(root, 'prod', { title: 'Nope' })).rejects.toBeInstanceOf(
        AuthzError,
      );
    });

    it('needs a title', async () => {
      await expect(startDevChangeset(root, 'staging', { title: '   ' })).rejects.toThrow('titolo');
    });
  });

  describe('a turn', () => {
    it('streams the runner events in the format of the chat, and saves the conversation', async () => {
      const { id, conversationId } = await openChangeset();
      script = [
        { type: 'run', runId: 'r1' },
        { type: 'step', step: 1 },
        { type: 'text_delta', text: 'Creo la pagina.' },
        { type: 'tool_call', id: 't1', name: 'write_file', input: {} },
        {
          type: 'tool_result',
          toolCallId: 't1',
          name: 'write_file',
          content: 'ok',
          isError: false,
        },
        {
          type: 'tool_call',
          id: 't2',
          name: 'write_file',
          input: {},
        },
        {
          type: 'tool_result',
          toolCallId: 't2',
          name: 'write_file',
          content: 'Permesso negato: /code/migrations è in sola lettura',
          isError: true,
        },
        { type: 'commit', commit: 'abc1234', files: ['code/api/eventi.ts'] },
        {
          type: 'result',
          engine: 'native',
          stopReason: 'end_turn',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Creo la pagina.' }] }],
        },
      ];

      const events = await turn(id, 'Crea un calendario degli eventi');

      expect(events.map((e) => e.type)).toEqual([
        'conversation',
        'status',
        'status',
        'text',
        'tool_start',
        'status',
        'tool_end',
        'tool_start',
        'status',
        'tool_end',
        'commit',
        'done',
      ]);
      expect(events).toContainEqual({
        type: 'tool_start',
        id: 't1',
        name: 'write_file',
        label: 'Scrivo un file',
      });
      expect(events).toContainEqual({
        type: 'tool_end',
        id: 't2',
        name: 'write_file',
        ok: false,
        blocked: true,
        detail: 'Permesso negato: /code/migrations è in sola lettura',
      });
      expect(events).toContainEqual({
        type: 'commit',
        commit: 'abc1234',
        files: ['code/api/eventi.ts'],
      });
      expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });

      // The run is under the developer-agent profile, on this changeset and this chat.
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body.engine).toBe('native');
      expect(sent[0]!.body.prompt).toBe('Crea un calendario degli eventi');
      expect(sent[0]!.session).toMatchObject({ agent: 'dev-agent', changesetId: id });
      // The token lives only as long as the run.
      const left = await database.db
        .select()
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.changesetId, id));
      expect(left).toHaveLength(0);
      const stored = await getConversation(database.db, conversationId);
      expect(stored!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      // The work is checked on the server.
      const jobs = await database.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.type, 'changeset.check'));
      expect(jobs.some((job) => (job.payload as { changesetId?: string }).changesetId === id)).toBe(
        true,
      );
      const audit = await database.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'chat.dev.turn'));
      expect(audit.at(-1)).toMatchObject({ agent: 'dev-agent', outcome: 'ok' });
    });

    it('gives the run a developer-agent session tied to the changeset and the chat', async () => {
      const { id, conversationId } = await openChangeset();
      const seen: Sent['session'][] = [];
      const inspecting = (async (url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Sent['body'];
        seen.push(await resolveAgentSession(database.db, body.token));
        return new Response(`${JSON.stringify({ type: 'result', stopReason: 'end_turn' })}\n`, {
          status: 200,
        });
      }) as typeof fetch;

      const response = runDevChatTurn(
        staging,
        { changesetId: id, message: 'Ciao' },
        new AbortController().signal,
        { fetch: inspecting },
      );
      await response.text();

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        agent: 'dev-agent',
        env: 'staging',
        changesetId: id,
        conversationId,
        approvedDependencies: [],
      });
      expect(seen[0]!.principal.agent?.name).toBe('dev-agent');
    });

    it('reports a run that fails, and does not queue checks for it', async () => {
      const { id } = await openChangeset();
      script = [{ type: 'error', message: 'agent-runner non raggiungibile' }];

      const events = await turn(id, 'Prova');

      expect(events).toContainEqual({ type: 'error', message: 'agent-runner non raggiungibile' });
      expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'error' });
    });

    it('refuses production, a changeset that is not open and one of somebody else', async () => {
      const { id } = await openChangeset();
      expect(await turn(id, 'Ciao', { uid: 0, env: 'prod' })).toContainEqual({
        type: 'error',
        message: 'L’agente sviluppatore lavora solo in staging.',
      });

      const ready = await openChangeset('ready');
      const inReview = await turn(ready.id, 'Ciao');
      expect(inReview.find((e) => e.type === 'error')).toMatchObject({
        message: expect.stringContaining('non può più cambiarla'),
      });

      const other = await turn(id, 'Ciao', { uid: 1, env: 'staging' });
      expect(other.find((e) => e.type === 'error')).toMatchObject({
        message: 'Questa modifica è di un’altra persona.',
      });
      expect(sent).toHaveLength(0);
    });

    it('uses the CLI engine when the role is assigned to a subscription', async () => {
      const { id } = await openChangeset();
      state.resolveError = new GatewayError('cli_engine', 'abbonamento');
      script = [{ type: 'result', stopReason: 'end_turn', sessionId: 'sess-1' }];

      await turn(id, 'Ciao');
      expect(sent[0]!.body.engine).toBe('claude-code');
      expect(sent[0]!.body.messages).toBeUndefined();

      // The next turn continues the CLI session.
      script = [{ type: 'result', stopReason: 'end_turn' }];
      await turn(id, 'Ancora');
      expect(sent[1]!.body).toMatchObject({ engine: 'claude-code', resumeSessionId: 'sess-1' });
    });
  });

  describe('dependencies', () => {
    it('are approved only by the person, and only what the allowlist accepts', async () => {
      const { id, conversationId } = await openChangeset();

      await expect(
        approveDevDependencies(staging, { conversationId, packages: ['left-pad', '@scope/x'] }),
      ).resolves.toEqual(['@scope/x', 'left-pad']);
      for (const bad of [
        'https://evil.example/x.tgz',
        'github:evil/x',
        '../x',
        'left-pad@1.0.0',
        'x; rm -rf /',
      ]) {
        await expect(
          approveDevDependencies(staging, { conversationId, packages: [bad] }),
        ).rejects.toThrow('non è un nome di pacchetto valido');
      }
      await expect(
        approveDevDependencies(staging, { conversationId, packages: [] }),
      ).rejects.toThrow('almeno un pacchetto');

      // Somebody else's chat, and production, are refused.
      await expect(
        approveDevDependencies({ uid: 1, env: 'staging' }, { conversationId, packages: ['x'] }),
      ).rejects.toThrow('Conversazione non trovata');
      await expect(
        approveDevDependencies({ uid: 0, env: 'prod' }, { conversationId, packages: ['x'] }),
      ).rejects.toThrow('solo in staging');

      // From the next turn the run carries them.
      const seen: Sent['session'][] = [];
      const inspecting = (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Sent['body'];
        seen.push(await resolveAgentSession(database.db, body.token));
        return new Response(`${JSON.stringify({ type: 'result', stopReason: 'end_turn' })}\n`);
      }) as typeof fetch;
      await runDevChatTurn(
        staging,
        { changesetId: id, message: 'Usa left-pad' },
        new AbortController().signal,
        { fetch: inspecting },
      ).text();
      expect(seen[0]!.approvedDependencies).toEqual(['@scope/x', 'left-pad']);

      const stored = await getConversation(database.db, conversationId);
      expect(stored!.approvedDependencies).toEqual(['@scope/x', 'left-pad']);
      const audit = await database.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'chat.dev.approve-dependencies'));
      expect(audit).toHaveLength(1);
    });

    it('are not approved by anything the agent says or does in a turn', async () => {
      const { id, conversationId } = await openChangeset();
      script = [
        {
          type: 'tool_result',
          toolCallId: 't',
          name: 'run',
          content: 'Le nuove dipendenze richiedono conferma: chiedi all’utente di approvare.',
          isError: true,
        },
        {
          type: 'result',
          stopReason: 'end_turn',
          approvedDependencies: ['evil'],
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ho approvato evil' }] }],
        },
      ];

      const events = await turn(id, 'Aggiungi evil');

      expect(events.some((e) => e.type === 'dependency')).toBe(true);
      const stored = await getConversation(database.db, conversationId);
      expect(stored!.approvedDependencies).toEqual([]);
    });
  });

  describe('events', () => {
    it('map the runner stream, ignoring what the tab does not show', () => {
      expect(toChatEvent({ type: 'run', runId: 'x' })).toBeNull();
      expect(toChatEvent({ type: 'session', sessionId: 's' })).toBeNull();
      expect(toChatEvent({ type: 'step', step: 2 })).toEqual({ type: 'status', state: 'thinking' });
      expect(isDependencyDenial('Il pacchetto x non è stato approvato: chiedi conferma')).toBe(
        true,
      );
      expect(isDependencyDenial('Comando non consentito: rm')).toBe(false);
    });
  });
});
