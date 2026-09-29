import type { PlanOperation, PlanResult } from '@ai-cms/content/service';
import { describe, expect, it } from 'vitest';
import {
  describeOperation,
  encodeSse,
  isBlockedResult,
  PlanStore,
  toolLabel,
  toPlanView,
} from './chat.ts';

const owner = { uid: 3, env: 'prod' } as const;

describe('encodeSse', () => {
  it('frames an event with its type and JSON data', () => {
    expect(encodeSse({ type: 'text', text: 'Ciao\nmondo' })).toBe(
      'event: text\ndata: {"type":"text","text":"Ciao\\nmondo"}\n\n',
    );
  });
});

describe('tool wording', () => {
  it('labels known tools in Italian and falls back for the others', () => {
    expect(toolLabel('create_page')).toBe('Creo una pagina');
    expect(toolLabel('qualcosa_di_nuovo')).toBe('Eseguo qualcosa_di_nuovo');
  });

  it('recognises the refusals of authz', () => {
    expect(isBlockedResult('Permesso negato: il codice è in sola lettura')).toBe(true);
    expect(isBlockedResult('Errore: nodo non trovato')).toBe(false);
  });
});

describe('toPlanView', () => {
  const operations: PlanOperation[] = [
    { op: 'createPage', parentPath: '/site/pages', name: 'contatti', body: {} },
    { op: 'delete', path: '/site/pages/vecchia' },
  ];
  const preview = {
    dryRun: true,
    touched: [],
    versions: [],
    published: [],
    unpublished: [],
    revalidate: [],
    preview: [
      {
        path: '/site/pages/contatti',
        kind: 'page',
        created: true,
        baseVersion: null,
        body: { blocks: [{}] },
        diff: {
          changed: true,
          blocks: { added: [{}, {}], removed: [], modified: [{}], moved: [] },
          fields: [],
        },
      },
    ],
  } as unknown as PlanResult;

  it('describes every step and summarises the pages', () => {
    const view = toPlanView(operations, preview);
    expect(view.steps).toEqual([
      'Creare la pagina «contatti» in /site/pages',
      'Eliminare /site/pages/vecchia',
    ]);
    expect(view.pages).toEqual([
      { path: '/site/pages/contatti', created: true, added: 2, removed: 0, changed: 1 },
    ]);
  });

  it('marks a plan with a deletion as destructive', () => {
    expect(toPlanView(operations, preview).destructive).toBe(true);
    expect(toPlanView(operations.slice(0, 1), preview).destructive).toBe(false);
  });

  it('describes operations without a dedicated wording', () => {
    expect(describeOperation({ op: 'publish', path: '/site/pages/x' })).toBe(
      'Pubblicare /site/pages/x',
    );
  });
});

describe('PlanStore', () => {
  it('gives the same plan back to its owner, and nobody else', () => {
    const store = new PlanStore();
    const session = store.session('c1', owner);
    session.propose({ op: 'delete', path: '/site/pages/x' });

    expect(store.session('c1', owner)).toBe(session);
    expect(store.find('c1', owner)).toBe(session);
    expect(store.find('c1', { uid: 4, env: 'prod' })).toBeNull();
    expect(store.find('c1', { uid: 3, env: 'staging' })).toBeNull();
  });

  it('finds nothing while the plan is empty', () => {
    const store = new PlanStore();
    store.session('c1', owner);
    expect(store.find('c1', owner)).toBeNull();
  });

  it('forgets a discarded plan and an expired one', () => {
    let now = 0;
    const store = new PlanStore(() => now, 1000);
    store.session('c1', owner).propose({ op: 'delete', path: '/site/pages/x' });
    store.session('c2', owner).propose({ op: 'delete', path: '/site/pages/y' });

    store.discard('c1');
    expect(store.find('c1', owner)).toBeNull();

    now = 1001;
    expect(store.find('c2', owner)).toBeNull();
  });
});
