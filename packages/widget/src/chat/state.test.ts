import { describe, expect, it } from 'vitest';
import {
  chatReducer,
  EMPTY_CHAT,
  explainFailure,
  type ChatAction,
  type ChatState,
} from './state.ts';
import type { ChatEvent, PlanView } from './stream.ts';

const run = (actions: ChatAction[], from: ChatState = EMPTY_CHAT) =>
  actions.reduce(chatReducer, from);
const events = (list: ChatEvent[]): ChatAction[] => list.map((event) => ({ kind: 'event', event }));

describe('chatReducer', () => {
  it('builds the assistant message from the stream, with its tools', () => {
    const state = run([
      { kind: 'send', text: 'Crea una pagina' },
      ...events([
        { type: 'conversation', id: 'c1', title: 'Crea una pagina' },
        { type: 'status', state: 'thinking' },
        { type: 'text', text: 'Ok, ' },
        { type: 'tool_start', id: 't1', name: 'create_page', label: 'Creo una pagina' },
        { type: 'tool_end', id: 't1', name: 'create_page', ok: true, blocked: false },
        { type: 'text', text: 'fatto.' },
        { type: 'done', stopReason: 'end_turn' },
      ]),
    ]);

    expect(state.conversationId).toBe('c1');
    expect(state.phase).toBe('idle');
    expect(state.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Crea una pagina'],
      ['assistant', 'Ok, fatto.'],
    ]);
    expect(state.messages[1]).toMatchObject({
      streaming: false,
      tools: [{ id: 't1', label: 'Creo una pagina', status: 'done' }],
    });
    expect(state.changed).toBe(true);
  });

  it('does not count reads and plans as changes to the site', () => {
    const state = run([
      { kind: 'send', text: 'Cosa c’è?' },
      ...events([
        { type: 'tool_start', id: 't1', name: 'read_node', label: 'Leggo un contenuto' },
        { type: 'tool_end', id: 't1', name: 'read_node', ok: true, blocked: false },
        { type: 'tool_start', id: 't2', name: 'propose_plan', label: 'Preparo un piano' },
        { type: 'tool_end', id: 't2', name: 'propose_plan', ok: true, blocked: false },
      ]),
    ]);
    expect(state.changed).toBe(false);
  });

  it('explains a refused tool call', () => {
    const state = run([
      { kind: 'send', text: 'Tocca il codice' },
      ...events([
        { type: 'tool_start', id: 't1', name: 'delete_node', label: 'Elimino un contenuto' },
        {
          type: 'tool_end',
          id: 't1',
          name: 'delete_node',
          ok: false,
          blocked: true,
          detail: 'Permesso negato: il codice non si modifica dall’agente contenuti.',
        },
      ]),
    ]);
    expect(state.messages[1]!.tools[0]).toMatchObject({
      status: 'blocked',
      detail: 'Non consentito: il codice non si modifica dall’agente contenuti.',
    });
    expect(state.changed).toBe(false);
  });

  const plan: PlanView = { steps: ['Eliminare /site/pages/x'], pages: [], destructive: true };

  it('keeps the plan until it is answered, and drops it on a new question', () => {
    const proposed = run([
      { kind: 'send', text: 'Elimina x' },
      ...events([
        { type: 'plan', plan },
        { type: 'done', stopReason: 'end_turn' },
      ]),
    ]);
    expect(proposed.plan).toEqual(plan);

    const applied = run(
      [{ kind: 'plan-answered', applied: true, note: 'Piano eseguito.' }],
      proposed,
    );
    expect(applied.plan).toBeNull();
    expect(applied.changed).toBe(true);
    expect(applied.messages.at(-1)).toMatchObject({ role: 'note', text: 'Piano eseguito.' });

    expect(run([{ kind: 'send', text: 'No, aspetta' }], proposed).plan).toBeNull();
  });

  it('stops a running answer and reports failures', () => {
    const running = run([
      { kind: 'send', text: 'Scrivi tanto' },
      ...events([{ type: 'text', text: 'Inizio…' }]),
    ]);
    expect(running.messages[1]!.streaming).toBe(true);

    const stopped = run([{ kind: 'stopped' }], running);
    expect(stopped.phase).toBe('idle');
    expect(stopped.messages[1]!.streaming).toBe(false);
    expect(run([{ kind: 'failed', message: 'Rete assente' }], running).error).toBe('Rete assente');
  });

  it('loads a saved conversation and starts a new one', () => {
    const loaded = run([
      {
        kind: 'loaded',
        id: 'c9',
        title: 'Vecchia',
        plan: null,
        lines: [
          { id: 1, role: 'user', text: 'Ciao', tools: [] },
          { id: 2, role: 'assistant', text: 'Ehi', tools: ['Creo una pagina'] },
        ],
      },
    ]);
    expect(loaded.conversationId).toBe('c9');
    expect(loaded.messages[1]!.tools[0]).toMatchObject({
      label: 'Creo una pagina',
      status: 'done',
    });
    expect(run([{ kind: 'reset' }], loaded)).toEqual(EMPTY_CHAT);
  });
});

describe('explainFailure', () => {
  it('drops the technical prefixes', () => {
    expect(explainFailure('Errore: nodo non trovato', false)).toBe('nodo non trovato');
    expect(explainFailure('', true)).toBe('Non consentito dalle regole del sito.');
  });
});
