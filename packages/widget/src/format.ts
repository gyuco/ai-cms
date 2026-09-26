import type { PageStatus } from './api.ts';

/** Collapses whitespace and cuts the text to `max` characters, ending with "…". */
export function shortText(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

const dateTime = new Intl.DateTimeFormat('it-IT', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** "26 set 2026, 11:10" in the browser's time zone; the input as is if it is not a date. */
export function formatDateTime(value: string | Date, formatter = dateTime): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? String(value) : formatter.format(date);
}

export type Tone = 'ok' | 'draft' | 'off';

/** Publication state of a page in words (E7.7). */
export function pageStateLabel(status: PageStatus): { label: string; tone: Tone } {
  if (status.publishedVersion === null) {
    return status.latestVersion === null
      ? { label: 'Senza contenuto', tone: 'off' }
      : { label: 'Bozza, mai pubblicata', tone: 'draft' };
  }
  return status.hasDraft
    ? { label: 'Pubblicata, con modifiche in bozza', tone: 'draft' }
    : { label: 'Pubblicata', tone: 'ok' };
}

/** `/site/pages/a/b` → `{ parent: '/site/pages/a', name: 'b' }`; null for the root. */
export function splitNodePath(path: string): { parent: string; name: string } | null {
  const index = path.lastIndexOf('/');
  if (index <= 0) return null;
  return { parent: path.slice(0, index), name: path.slice(index + 1) };
}

/** `/site/pages/a/b` → `/a/b`, `/site/pages/index` → `/`; null outside the pages. */
export function pageUrlOf(path: string): string | null {
  if (path === '/site/pages/index') return '/';
  return path.startsWith('/site/pages/') ? path.slice('/site/pages'.length) : null;
}

/** "1 versione", "3 versioni". */
export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** Suggests a node name from a title: "Chi siamo?" → "chi-siamo". */
export function slugify(title: string): string {
  return title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

export const PAGES_ROOT = '/site/pages';

/**
 * Parent node for a page typed as a site URL (`/progetti` → `/site/pages/progetti`); empty
 * or `/` is the top level. Null when the URL cannot be a page.
 */
export function parentFromUrl(value: string): string | null {
  const clean = value.trim().replace(/^\/+|\/+$/g, '');
  if (clean === '') return PAGES_ROOT;
  if (!clean.split('/').every((part) => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(part))) return null;
  return `${PAGES_ROOT}/${clean}`;
}
