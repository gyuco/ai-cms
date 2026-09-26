import { useEffect, useState } from 'preact/hooks';
import { shortText } from './format.ts';

/** A block of the page chosen with the "select" mode (TECHNICAL §10.4), for the chat. */
export interface BlockRef {
  /** Node that owns the block (`data-cms-node`), e.g. `/site/pages/chi-siamo`. */
  path: string | null;
  /** `data-cms-block` of the element. */
  blockId: string;
  /** Short, readable description of the element. */
  text: string;
}

export interface SelectionState {
  selecting: boolean;
  selected: BlockRef | null;
}

type Listener = (state: SelectionState) => void;

export interface SelectionStore {
  get(): SelectionState;
  subscribe(listener: Listener): () => void;
  start(): void;
  cancel(): void;
  select(ref: BlockRef): void;
  clear(): void;
}

export function createSelectionStore(): SelectionStore {
  let state: SelectionState = { selecting: false, selected: null };
  const listeners = new Set<Listener>();
  const set = (next: SelectionState) => {
    if (next.selecting === state.selecting && next.selected === state.selected) return;
    state = next;
    for (const listener of listeners) listener(state);
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => set({ ...state, selecting: true }),
    cancel: () => set({ ...state, selecting: false }),
    select: (ref) => set({ selecting: false, selected: ref }),
    clear: () => set({ ...state, selected: null }),
  };
}

/** Shared by the whole widget: the chat reads the selected block from here. */
export const selection = createSelectionStore();

export function useSelection(store: SelectionStore = selection): SelectionState {
  const [state, setState] = useState(store.get);
  useEffect(() => {
    setState(store.get());
    return store.subscribe(setState);
  }, [store]);
  return state;
}

export const BLOCK_SELECTOR = '[data-cms-block]';

const KIND_LABEL: Record<string, string> = {
  H1: 'Titolo',
  H2: 'Titolo',
  H3: 'Titolo',
  H4: 'Titolo',
  H5: 'Titolo',
  H6: 'Titolo',
  P: 'Paragrafo',
  IMG: 'Immagine',
  FIGURE: 'Immagine',
  UL: 'Elenco',
  OL: 'Elenco',
  A: 'Link',
  SECTION: 'Sezione',
  HEADER: 'Intestazione',
  FOOTER: 'Piè di pagina',
  NAV: 'Menu',
  BLOCKQUOTE: 'Citazione',
  TABLE: 'Tabella',
};

/** "Titolo", "Immagine", … from the element's tag, or "Blocco". */
export function blockKind(element: Element): string {
  return KIND_LABEL[element.tagName] ?? 'Blocco';
}

/** Elements whose boundaries separate words even without whitespace in the markup. */
const SEPARATED = new Set([
  'A',
  'LI',
  'P',
  'DIV',
  'BR',
  'TD',
  'TH',
  'BUTTON',
  'FIGCAPTION',
  'DT',
  'DD',
]);

function readableText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeType !== 1) return '';
  const inner = [...node.childNodes].map(readableText).join('');
  return SEPARATED.has((node as Element).tagName) || /^H[1-6]$/.test((node as Element).tagName)
    ? ` ${inner} `
    : inner;
}

/** Short text of a block: its text, or the alt text of its image, or its kind. */
export function blockText(element: Element): string {
  const text = shortText(readableText(element));
  if (text) return text;
  const alt = element.matches('img') ? element.getAttribute('alt') : null;
  const image = alt ?? element.querySelector('img[alt]')?.getAttribute('alt');
  if (image) return shortText(image);
  return blockKind(element);
}

/** The reference for a block element; the owner node comes from the closest `data-cms-node`. */
export function blockRef(element: Element, fallbackPath: string | null = null): BlockRef {
  return {
    path: element.closest('[data-cms-node]')?.getAttribute('data-cms-node') ?? fallbackPath,
    blockId: element.getAttribute('data-cms-block') ?? '',
    text: blockText(element),
  };
}

/** The innermost block among the elements under the pointer (topmost first). */
export function blockAt(elements: readonly Element[]): Element | null {
  for (const element of elements) {
    const block = element.closest(BLOCK_SELECTOR);
    if (block) return block;
  }
  return null;
}

/** Every block of the page, in document order. */
export function listBlocks(root: ParentNode = document): Element[] {
  return [...root.querySelectorAll(BLOCK_SELECTOR)].filter(
    (element) => element.getAttribute('data-cms-block') !== '',
  );
}

export function findBlock(ref: BlockRef, root: ParentNode = document): Element | null {
  for (const element of listBlocks(root)) {
    if (element.getAttribute('data-cms-block') !== ref.blockId) continue;
    const path = element.closest('[data-cms-node]')?.getAttribute('data-cms-node') ?? null;
    if (ref.path === null || path === null || path === ref.path) return element;
  }
  return null;
}
