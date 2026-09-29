// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { applyPreview, findMain, type PlanPagePreview } from './preview.ts';

const ORIGINAL = '<h1 data-cms-block="b1">Ciao</h1><p data-cms-block="b2">Testo</p>';

function page(): HTMLElement {
  document.body.innerHTML = `<header>Testata</header><main data-cms-node="/site/pages/chi-siamo">${ORIGINAL}</main>`;
  return document.querySelector('main') as HTMLElement;
}

const preview: PlanPagePreview = {
  path: '/site/pages/chi-siamo',
  created: false,
  html: '<h1 data-cms-block="b1">Ciao mondo</h1><p data-cms-block="b2">Testo</p><p data-cms-block="b3">Nuovo</p>',
  added: ['b3'],
  modified: ['b1'],
  removed: [{ id: 'b9', type: 'quote' }],
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('findMain', () => {
  it('finds the <main> of a node by its path', () => {
    const main = page();
    expect(findMain(document, '/site/pages/chi-siamo')).toBe(main);
    expect(findMain(document, '/site/pages/altra')).toBeNull();
  });
});

describe('applyPreview', () => {
  it('swaps <main> and outlines the added and modified blocks', () => {
    const main = page();
    const applied = applyPreview(document, preview);
    expect(applied?.highlighted).toBe(2);
    expect(main.innerHTML).toContain('Ciao mondo');
    expect(main.getAttribute('data-cms-previewing')).toBe('true');
    expect(main.querySelector('[data-cms-block="b3"]')?.getAttribute('data-cms-preview')).toBe(
      'added',
    );
    expect(main.querySelector('[data-cms-block="b1"]')?.getAttribute('data-cms-preview')).toBe(
      'modified',
    );
    expect(
      main.querySelector('[data-cms-block="b2"]')?.getAttribute('data-cms-preview'),
    ).toBeNull();
  });

  it('puts the original markup back on restore, also when called twice', () => {
    const main = page();
    const applied = applyPreview(document, preview);
    applied?.restore();
    expect(main.innerHTML).toBe(ORIGINAL);
    expect(main.hasAttribute('data-cms-previewing')).toBe(false);
    applied?.restore();
    expect(main.innerHTML).toBe(ORIGINAL);
  });

  it('keeps the first original when a preview is applied over another', () => {
    const main = page();
    applyPreview(document, preview);
    const second = applyPreview(document, { ...preview, html: '<p>Terza</p>', added: [] });
    expect(main.innerHTML).toBe('<p>Terza</p>');
    second?.restore();
    expect(main.innerHTML).toBe(ORIGINAL);
  });

  it('leaves the page alone when it has no matching <main>', () => {
    page();
    expect(applyPreview(document, { ...preview, path: '/site/pages/altra' })).toBeNull();
    expect(document.querySelector('main')?.innerHTML).toBe(ORIGINAL);
  });
});
