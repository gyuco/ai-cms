// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shortText } from './format.ts';
import {
  blockAt,
  blockKind,
  blockRef,
  createSelectionStore,
  findBlock,
  listBlocks,
} from './selection.ts';

describe('selection store', () => {
  it('starts, selects, cancels and clears, notifying only on changes', () => {
    const store = createSelectionStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.get()).toEqual({ selecting: false, selected: null });

    store.start();
    store.start();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get().selecting).toBe(true);

    const ref = { path: '/site/pages/index', blockId: 'b1', text: 'Benvenuti' };
    store.select(ref);
    expect(store.get()).toEqual({ selecting: false, selected: ref });

    // Cancelling a new selection keeps the previous choice.
    store.start();
    store.cancel();
    expect(store.get()).toEqual({ selecting: false, selected: ref });

    store.clear();
    expect(store.get().selected).toBeNull();
    unsubscribe();
    store.start();
    expect(listener).toHaveBeenCalledTimes(5);
  });
});

describe('shortText', () => {
  it('collapses whitespace and truncates', () => {
    expect(shortText('  Ciao\n\n  mondo  ')).toBe('Ciao mondo');
    expect(shortText('abcdefghij', 6)).toBe('abcde…');
    expect(shortText('abc', 3)).toBe('abc');
  });
});

describe('block helpers', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function page() {
    document.body.innerHTML = `
      <header data-cms-node="/site/layouts/header">
        <nav data-cms-block="menu"><a href="/">Home</a><a href="/chi-siamo">Chi siamo</a></nav>
      </header>
      <main data-cms-node="/site/pages/chi-siamo">
        <h1 data-cms-block="t1">  Chi   siamo </h1>
        <p data-cms-block="p1">Uno studio di <em id="em">architettura</em> a Milano.</p>
        <figure data-cms-block="img1"><img src="/a.jpg" alt="La sede dello studio"></figure>
        <div data-cms-block="">vuoto</div>
      </main>
      <aside data-cms-block="loose"></aside>`;
  }

  it('lists the blocks in document order, skipping empty ids', () => {
    page();
    expect(listBlocks().map((el) => el.getAttribute('data-cms-block'))).toEqual([
      'menu',
      't1',
      'p1',
      'img1',
      'loose',
    ]);
  });

  it('describes a block with its owner node and a short text', () => {
    page();
    const [menu, title, , image, loose] = listBlocks();
    expect(blockRef(title!)).toEqual({
      path: '/site/pages/chi-siamo',
      blockId: 't1',
      text: 'Chi siamo',
    });
    expect(blockRef(menu!).path).toBe('/site/layouts/header');
    expect(blockRef(menu!).text).toBe('Home Chi siamo');
    expect(blockRef(image!).text).toBe('La sede dello studio');
    expect(blockRef(loose!, '/site/pages/x')).toEqual({
      path: '/site/pages/x',
      blockId: 'loose',
      text: 'Blocco',
    });
    expect(blockKind(title!)).toBe('Titolo');
    expect(blockKind(image!)).toBe('Immagine');
  });

  it('finds the innermost block under the pointer and a block by reference', () => {
    page();
    const em = document.getElementById('em')!;
    expect(blockAt([document.body])).toBeNull();
    expect(blockAt([em, document.body])?.getAttribute('data-cms-block')).toBe('p1');
    expect(findBlock({ path: '/site/pages/chi-siamo', blockId: 'p1', text: '' })?.tagName).toBe(
      'P',
    );
    expect(findBlock({ path: '/site/pages/altro', blockId: 'p1', text: '' })).toBeNull();
    expect(findBlock({ path: null, blockId: 'menu', text: '' })?.tagName).toBe('NAV');
  });
});
