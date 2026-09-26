/**
 * The per-turn context of the content agent (E9.2): what the widget knows about the page the
 * user is looking at, which the system prompt must repeat on every turn since the user can
 * navigate or change selection between messages of the same conversation.
 */
import type { Env } from '@ai-cms/authz';
import type { OutlineEntry } from '@ai-cms/content';

/**
 * A block picked with the widget's "select" mode (`@ai-cms/widget` `BlockRef`), as it travels
 * over the wire in the chat request. Kept as a plain shape here instead of importing the
 * widget package, which is a browser bundle.
 */
export interface SelectedBlock {
  /** Tree path of the node that owns the block, e.g. `/site/pages/chi-siamo`; null if unknown. */
  path: string | null;
  blockId: string;
  /** Short, readable description of the element, as shown in the widget. */
  text: string;
}

export interface PageContext {
  env: Env;
  /** Tree path of the page open in the widget; null when the user has no page open (e.g. the tree view). */
  path: string | null;
  title?: string | null;
  /** Heading structure of the rendered page (TECHNICAL §11.3), so the agent picks the right level. */
  outline: readonly OutlineEntry[];
  selected: SelectedBlock | null;
}

const ENV_LABEL: Record<Env, string> = { prod: 'produzione', staging: 'staging' };

function renderOutline(outline: readonly OutlineEntry[]): string {
  if (outline.length === 0) return 'Struttura dei titoli: nessun titolo nella pagina.';
  const lines = outline.map((entry) => `  H${entry.level} ${entry.text} (id: ${entry.id})`);
  return ['Struttura dei titoli della pagina (outline), in ordine:', ...lines].join('\n');
}

function renderSelected(selected: SelectedBlock | null): string {
  if (!selected) return 'Elemento selezionato: nessuno.';
  const where = selected.path ? `, nodo ${selected.path}` : '';
  return `Elemento selezionato: "${selected.text}" (blocco ${selected.blockId}${where}).`;
}

/** Renders the dynamic part of the system prompt: current page, outline, selection, environment. */
export function renderPageContext(context: PageContext): string {
  const page = context.path
    ? `Pagina corrente: ${context.path}${context.title ? ` ("${context.title}")` : ''}.`
    : "Pagina corrente: nessuna, l'utente sta guardando l'albero del sito.";
  return [
    `Ambiente: ${ENV_LABEL[context.env]}.`,
    page,
    renderOutline(context.outline),
    renderSelected(context.selected),
  ].join('\n');
}
