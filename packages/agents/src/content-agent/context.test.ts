import { describe, expect, it } from 'vitest';
import { renderPageContext, type PageContext } from './context.ts';

const base: PageContext = {
  env: 'prod',
  path: '/site/pages/chi-siamo',
  title: 'Chi siamo',
  outline: [
    { id: 'b1', level: 1, text: 'Chi siamo' },
    { id: 'b2', level: 2, text: 'Il team' },
  ],
  selected: { path: '/site/pages/chi-siamo', blockId: 'b2', text: 'Il team' },
};

describe('renderPageContext', () => {
  it('names the environment', () => {
    expect(renderPageContext(base)).toContain('Ambiente: produzione.');
    expect(renderPageContext({ ...base, env: 'staging' })).toContain('Ambiente: staging.');
  });

  it('describes the current page with its title', () => {
    expect(renderPageContext(base)).toContain(
      'Pagina corrente: /site/pages/chi-siamo ("Chi siamo").',
    );
  });

  it('says when no page is open', () => {
    const text = renderPageContext({ ...base, path: null, title: null });
    expect(text).toContain('nessuna');
    expect(text).not.toContain('Pagina corrente: /');
  });

  it('lists the outline in order with heading levels', () => {
    const text = renderPageContext(base);
    expect(text).toContain('H1 Chi siamo (id: b1)');
    expect(text).toContain('H2 Il team (id: b2)');
  });

  it('says when the page has no headings', () => {
    expect(renderPageContext({ ...base, outline: [] })).toContain('nessun titolo');
  });

  it('describes the selected block and its node', () => {
    expect(renderPageContext(base)).toContain(
      'Elemento selezionato: "Il team" (blocco b2, nodo /site/pages/chi-siamo).',
    );
  });

  it('says when nothing is selected', () => {
    expect(renderPageContext({ ...base, selected: null })).toContain(
      'Elemento selezionato: nessuno.',
    );
  });

  it('omits the node when the selected block has no path', () => {
    const text = renderPageContext({
      ...base,
      selected: { path: null, blockId: 'b3', text: 'Logo' },
    });
    expect(text).toContain('Elemento selezionato: "Logo" (blocco b3).');
    expect(text).not.toContain('nodo');
  });
});
