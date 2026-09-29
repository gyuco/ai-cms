/**
 * In-place preview of a plan (E7.5, TECHNICAL §10.4): the `<main>` of the page the person is
 * looking at is swapped, for as long as the plan waits, with the page as the plan would leave
 * it, and the blocks it adds or edits are outlined. "Annulla" (or any answer) puts the
 * original markup back. The widget lives in a shadow root, so the highlight is inline style
 * on the page's own elements: nothing is added to the page's `<head>`.
 */

/** A page as the plan would leave it (`PlanPagePreview` in cms-api). */
export interface PlanPagePreview {
  path: string;
  created: boolean;
  /** The markup inside `<main>`, as the site renders it. */
  html: string;
  added: string[];
  modified: string[];
  removed: { id: string; type: string }[];
}

export interface AppliedPreview {
  /** Puts the original markup of `<main>` back. Safe to call more than once. */
  restore(): void;
  /** How many blocks of the preview are outlined. */
  highlighted: number;
}

const ADDED = '2px solid #1a7f37';
const MODIFIED = '2px solid #bf8700';

/** The `<main>` of the node `path` (`/site/pages/chi-siamo`), as the site marks it. */
export function findMain(doc: Document, path: string): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>('main[data-cms-node]')) {
    if (el.getAttribute('data-cms-node') === path) return el;
  }
  return null;
}

function outline(main: HTMLElement, ids: readonly string[], value: string, kind: string): number {
  let count = 0;
  for (const el of main.querySelectorAll<HTMLElement>('[data-cms-block]')) {
    const id = el.getAttribute('data-cms-block');
    if (!id || !ids.includes(id)) continue;
    el.style.outline = value;
    el.style.outlineOffset = '2px';
    el.setAttribute('data-cms-preview', kind);
    count += 1;
  }
  return count;
}

/** The markup `<main>` had before the preview, kept while it is on. */
const originals = new WeakMap<HTMLElement, string>();

/**
 * Swaps the preview into the page. Returns `null` when the page has no matching `<main>`
 * (another page, or a site that does not mark its nodes): nothing is touched then.
 */
export function applyPreview(doc: Document, preview: PlanPagePreview): AppliedPreview | null {
  const main = findMain(doc, preview.path);
  if (!main) return null;
  // Applying over a preview already on keeps the very first original.
  if (!originals.has(main)) originals.set(main, main.innerHTML);
  const original = originals.get(main) as string;
  main.innerHTML = preview.html;
  main.setAttribute('data-cms-previewing', 'true');
  // Modified wins over added if the same id is in both lists.
  const highlighted =
    outline(main, preview.added, ADDED, 'added') +
    outline(main, preview.modified, MODIFIED, 'modified');
  return {
    highlighted,
    restore() {
      if (!originals.has(main)) return;
      main.innerHTML = original;
      main.removeAttribute('data-cms-previewing');
      originals.delete(main);
    },
  };
}
