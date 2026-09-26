/** Folder of the site pages, in ltree form. */
export const PAGES_PATH = 'site.pages';
/** The home page: `/` on the site. */
export const HOME_PAGE_PATH = 'site.pages.index';

const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * Maps a site URL path to the node of its page, in ltree form: `/` is `site.pages.index`,
 * `/chi-siamo/team` is `site.pages.chi-siamo.team`. Returns null when the path cannot be a
 * page (e.g. upper case letters, dots or `/_cms/...`).
 */
export function pageNodePath(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split(/[?#]/, 1)[0] ?? '');
  } catch {
    return null;
  }
  const segments = decoded.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return HOME_PAGE_PATH;
  if (!segments.every((segment) => SEGMENT.test(segment))) return null;
  return `${PAGES_PATH}.${segments.join('.')}`;
}

/** Inverse of `pageNodePath`: the URL of a page node (ltree or public form), or null. */
export function pageUrl(nodePath: string): string | null {
  const ltree = nodePath.replace(/^\//, '').replaceAll('/', '.');
  if (ltree === HOME_PAGE_PATH) return '/';
  if (!ltree.startsWith(`${PAGES_PATH}.`)) return null;
  return `/${ltree.slice(PAGES_PATH.length + 1).replaceAll('.', '/')}`;
}
