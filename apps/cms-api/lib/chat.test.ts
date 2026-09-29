import type { ChatStreamEvent } from '@ai-cms/agents';
import type { ChatEngine, ChatEvent, ChatRequest } from '@ai-cms/ai';
import { GatewayError, getConversation } from '@ai-cms/ai-config';
import { getContent } from '@ai-cms/content/service';
import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  turns: [] as ChatEvent[][],
  requests: [] as ChatRequest[],
  openError: undefined as Error | undefined,
}));

vi.mock('./db.ts', () => ({ db: () => state.db }));
vi.mock('./assets.ts', () => ({ assetStorage: async () => undefined }));
vi.mock('./sites.ts', () => ({ revalidateSite: async () => undefined }));
vi.mock('./ai.ts', () => ({
  gateway: () => ({
    async open() {
      if (state.openError) throw state.openError;
      const engine: ChatEngine = {
        provider: 'anthropic',
        capabilities: async () => ({ tools: true, vision: false, streaming: true }),
        async *stream(req) {
          state.requests.push(structuredClone(req));
          const turn = state.turns.shift();
          if (!turn) throw new Error('no more scripted turns');
          yield* turn;
        },
      };
      return { engine, model: 'fake-model', role: 'content-agent', connection: { id: 'fake' } };
    },
  }),
}));

const {
  answerPlan,
  chatErrorMessage,
  linesOf,
  pendingPlan,
  pendingPlanPreview,
  plans,
  runChatTurn,
} = await import('./chat.ts');

const owner = { uid: 0, env: 'prod' } as const;
const page = (title: string) => ({ meta: { title }, blocks: [] });

const call = (id: string, name: string, input: unknown): ChatEvent[] => [
  { type: 'tool_call', id, name, input },
  { type: 'done', stopReason: 'tool_use' },
];
const say = (text: string): ChatEvent[] => [
  { type: 'text_delta', text },
  { type: 'done', stopReason: 'end_turn' },
];

async function turn(
  input: Partial<Parameters<typeof runChatTurn>[1]> & { message: string },
  who: { uid: number; env: 'prod' | 'staging' } = owner,
): Promise<ChatStreamEvent[]> {
  const response = runChatTurn(
    who,
    { conversationId: null, path: null, selected: null, ...input },
    new AbortController().signal,
  );
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const text = await response.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.split('\ndata: ')[1]!) as ChatStreamEvent);
}

describe.skipIf(!testDatabaseUrl)('chat turn (E7.4)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
    state.db = database.db;
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(() => {
    state.turns = [];
    state.requests = [];
    state.openError = undefined;
  });

  const conversationOf = (events: ChatStreamEvent[]) =>
    (events.find((e) => e.type === 'conversation') as { id: string }).id;

  it('streams the answer, and saves the conversation', async () => {
    state.turns = [say('Ciao! Cosa vuoi fare?')];
    const events = await turn({ message: 'Ciao' });

    expect(events.map((e) => e.type)).toEqual(['conversation', 'status', 'text', 'done']);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    const stored = await getConversation(database.db, conversationOf(events));
    expect(stored?.title).toBe('Ciao');
    expect(linesOf(stored!).map((l) => [l.role, l.text])).toEqual([
      ['user', 'Ciao'],
      ['assistant', 'Ciao! Cosa vuoi fare?'],
    ]);
    expect(state.requests[0]!.system).toContain('Ambiente: produzione.');
  });

  it('continues a conversation with its history, and hides it from other users', async () => {
    state.turns = [say('Uno')];
    const id = conversationOf(await turn({ message: 'Primo' }));
    state.turns = [say('Due')];
    await turn({ message: 'Secondo', conversationId: id });
    expect(state.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

    const events = await turn({ message: 'Intruso', conversationId: id }, { uid: 99, env: 'prod' });
    expect(events).toEqual([
      { type: 'error', message: 'Conversazione non trovata.' },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('renders the page as the waiting plan would leave it, without writing it (E7.5)', async () => {
    state.turns = [
      call('c1', 'propose_plan', {
        operations: [
          {
            op: 'createPage',
            parentPath: '/site/pages',
            name: 'anteprima',
            body: {
              meta: { title: 'Anteprima' },
              blocks: [{ id: 'h1', type: 'heading', level: 1, text: 'Titolo <nuovo>' }],
            },
          },
        ],
      }),
      say('Pronto.'),
    ];
    const id = conversationOf(await turn({ message: 'Crea la pagina anteprima' }));

    const preview = await pendingPlanPreview(owner, id, '/site/pages/anteprima');
    expect(preview).toMatchObject({
      path: '/site/pages/anteprima',
      created: true,
      removed: [],
    });
    expect(preview?.added).toEqual(['h1']);
    expect(preview?.html).toContain('data-cms-block="h1"');
    // Text is escaped, as on the site.
    expect(preview?.html).toContain('Titolo &lt;nuovo&gt;');
    // A page the plan does not touch has no preview.
    expect(await pendingPlanPreview(owner, id, '/site/pages/index')).toBeNull();
    // Nothing was written.
    await expect(
      getContent(
        database.db,
        { uid: 0, username: 'root', status: 'active' },
        'prod',
        '/site/pages/anteprima',
      ),
    ).rejects.toThrow();
    // Another user cannot see it.
    await expect(
      pendingPlanPreview({ uid: 99, env: 'prod' }, id, '/site/pages/anteprima'),
    ).rejects.toThrow();
  });

  it('shows the plan the agent proposes and applies it only on "Conferma"', async () => {
    state.turns = [
      call('c1', 'propose_plan', {
        operations: [
          { op: 'createPage', parentPath: '/site/pages', name: 'contatti', body: page('Contatti') },
        ],
      }),
      say('Ho preparato la pagina Contatti.'),
    ];
    const events = await turn({ message: 'Crea la pagina contatti' });
    const id = conversationOf(events);

    const plan = events.find((e) => e.type === 'plan');
    expect(plan).toMatchObject({
      plan: { steps: ['Creare la pagina «contatti» in /site/pages'], destructive: false },
    });
    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true, blocked: false });
    // Proposed, not written.
    await expect(
      getContent(
        database.db,
        { uid: 0, username: 'root', status: 'active' },
        'prod',
        '/site/pages/contatti',
      ),
    ).rejects.toThrow();
    expect((await pendingPlan(owner, id))?.steps).toHaveLength(1);

    const result = await answerPlan(owner, {
      conversationId: id,
      action: 'confirm',
      confirmDestructive: false,
    });
    expect(result).toMatchObject({ status: 'applied', touched: ['/site/pages/contatti'] });
    expect(
      (
        await getContent(
          database.db,
          { uid: 0, username: 'root', status: 'active' },
          'prod',
          '/site/pages/contatti',
        )
      ).node.path,
    ).toBe('/site/pages/contatti');
    expect(await pendingPlan(owner, id)).toBeNull();

    // The next turn tells the agent what happened to the plan.
    state.turns = [say('Fatto')];
    await turn({ message: 'Grazie', conversationId: id });
    const last = state.requests.at(-1)!.messages.at(-1)!;
    expect(JSON.stringify(last)).toContain('ha confermato il piano');
  });

  it('cancels a plan without touching the site', async () => {
    state.turns = [
      call('c1', 'propose_plan', {
        operations: [
          { op: 'createPage', parentPath: '/site/pages', name: 'annullata', body: page('No') },
        ],
      }),
      say('Piano pronto.'),
    ];
    const id = conversationOf(await turn({ message: 'Crea annullata' }));

    expect(
      await answerPlan(owner, { conversationId: id, action: 'cancel', confirmDestructive: false }),
    ).toEqual({ status: 'cancelled' });
    expect(plans.find(id, owner)).toBeNull();
    await expect(
      getContent(
        database.db,
        { uid: 0, username: 'root', status: 'active' },
        'prod',
        '/site/pages/annullata',
      ),
    ).rejects.toThrow();
    // A plan answered once cannot be answered again.
    await expect(
      answerPlan(owner, { conversationId: id, action: 'confirm', confirmDestructive: false }),
    ).rejects.toThrow('nessun piano in attesa');
  });

  it('asks for an explicit confirmation before a destructive plan', async () => {
    state.turns = [
      call('c1', 'propose_plan', {
        operations: [
          { op: 'createPage', parentPath: '/site/pages', name: 'vecchia', body: page('Vecchia') },
        ],
      }),
      say('Creata.'),
    ];
    const first = conversationOf(await turn({ message: 'Crea vecchia' }));
    await answerPlan(owner, {
      conversationId: first,
      action: 'confirm',
      confirmDestructive: false,
    });

    state.turns = [
      call('c2', 'propose_plan', { operations: [{ op: 'delete', path: '/site/pages/vecchia' }] }),
      say('Vuoi davvero eliminarla?'),
    ];
    const events = await turn({ message: 'Elimina vecchia' });
    const id = conversationOf(events);
    expect(events.find((e) => e.type === 'plan')).toMatchObject({ plan: { destructive: true } });

    await expect(
      answerPlan(owner, { conversationId: id, action: 'confirm', confirmDestructive: false }),
    ).rejects.toThrow('conferma esplicita');
    expect(plans.find(id, owner)).not.toBeNull();

    expect(
      await answerPlan(owner, { conversationId: id, action: 'confirm', confirmDestructive: true }),
    ).toMatchObject({ status: 'applied' });
  });

  it('gives an invalid plan back to the agent and keeps the earlier operations', async () => {
    state.turns = [
      call('c1', 'propose_plan', {
        operations: [{ op: 'delete', path: '/site/pages/non-esiste' }],
      }),
      say('Quella pagina non esiste.'),
    ];
    const events = await turn({ message: 'Elimina non-esiste' });
    const end = events.find((e) => e.type === 'tool_end');
    expect(end).toMatchObject({ ok: false, blocked: false });
    expect(events.some((e) => e.type === 'plan')).toBe(false);
    expect(plans.find(conversationOf(events), owner)).toBeNull();
  });

  it('explains a refusal of the system constraints', async () => {
    state.turns = [
      call('c1', 'propose_plan', {
        operations: [{ op: 'createNode', parentPath: '/code', name: 'hack', kind: 'dir' }],
      }),
      say('Non posso toccare il codice.'),
    ];
    const events = await turn({ message: 'Crea una cartella in /code' });
    const end = events.find((e) => e.type === 'tool_end');
    expect(end).toMatchObject({ ok: false });
    expect(events.some((e) => e.type === 'plan')).toBe(false);
  });

  it('starts from a page: outline in the prompt, conversation tied to the page', async () => {
    state.turns = [say('Ok')];
    const events = await turn({ message: 'Che titoli ho?', path: '/site/pages/index' });
    expect(state.requests[0]!.system).toContain('Pagina corrente: /site/pages/index');
    const { listNodeConversations } = await import('@ai-cms/ai-config');
    const node = (
      await getContent(
        database.db,
        { uid: 0, username: 'root', status: 'active' },
        'prod',
        '/site/pages/index',
      )
    ).node;
    const list = await listNodeConversations(database.db, owner, node.id);
    expect(list.map((c) => c.id)).toContain(conversationOf(events));
  });

  it('reports a missing AI connection as an error event', async () => {
    state.openError = new GatewayError('no_connection', 'Nessuna connessione AI configurata.');
    const events = await turn({ message: 'Ciao' });
    expect(events.at(-2)).toEqual({
      type: 'error',
      message: 'Nessuna connessione AI configurata.',
    });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'error' });
  });
});

describe('chatErrorMessage', () => {
  it('explains the subscription engine, and hides unexpected failures', () => {
    expect(chatErrorMessage(new GatewayError('cli_engine', 'x'))).toContain('abbonamento');
    expect(chatErrorMessage(new Error('password=segreta'))).not.toContain('segreta');
  });
});
