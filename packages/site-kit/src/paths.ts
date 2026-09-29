/** Tree node holding the pages (ltree form). */
export const PAGES_ROOT = 'site.pages';
/** The home page node: `/` on the site. */
export const HOME_NODE = `${PAGES_ROOT}.index`;
export const SETTINGS_NODE = 'site.settings';
export const HEADER_NODE = 'site.layouts.header';
export const FOOTER_NODE = 'site.layouts.footer';
/** The menu shown in the header of every page. */
export const MENU_NODE = 'site.menus.main';

/** Same rule as the `nodes.name` check constraint. */
const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Splits a public path (`/blog/primo`, `/`, `/chi-siamo/`) into its segments. */
export function pathSegments(publicPath: string): string[] {
  return publicPath.split('/').filter((segment) => segment !== '');
}

/**
 * Maps the segments of a public URL to the page node: `[]` → `site.pages.index`,
 * `['blog', 'primo']` → `site.pages.blog.primo`. Returns null for paths that cannot name a
 * page, including `/index` (the home page has a single address, `/`).
 */
export function pageNodeFromSegments(segments: readonly string[]): string | null {
  if (segments.length === 0) return HOME_NODE;
  if (segments.length === 1 && segments[0] === 'index') return null;
  if (!segments.every((segment) => SEGMENT.test(segment))) return null;
  return `${PAGES_ROOT}.${segments.join('.')}`;
}

/** `/chi-siamo` → `site.pages.chi-siamo`; null when the path cannot name a page. */
export function pageNodeFromPath(publicPath: string): string | null {
  if (!publicPath.startsWith('/')) return null;
  return pageNodeFromSegments(pathSegments(publicPath));
}

/** `site.pages.blog.primo` → `/blog/primo`; `site.pages.index` → `/`. Null outside pages. */
export function publicPathFromNode(nodePath: string): string | null {
  if (nodePath === HOME_NODE) return '/';
  if (!nodePath.startsWith(`${PAGES_ROOT}.`)) return null;
  return `/${nodePath.slice(PAGES_ROOT.length + 1).replaceAll('.', '/')}`;
}

/** Normalizes a public path: leading slash, no trailing slash (except `/`). */
export function normalizePublicPath(publicPath: string): string {
  const segments = pathSegments(publicPath);
  return `/${segments.join('/')}`;
}

/** `site.pages.index` → `/site/pages/index`, the form shown to users and in `data-cms-node`. */
export function treePath(nodePath: string): string {
  return `/${nodePath.split('.').filter(Boolean).join('/')}`;
}
