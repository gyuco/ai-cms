/** True when `path` equals `prefix` or lies below it. `''` (the root) is an ancestor of all. */
export function isUnder(path: string, prefix: string): boolean {
  if (prefix === '') return true;
  return path === prefix || path.startsWith(`${prefix}.`);
}

/** `/site/pages` → `site.pages`; `/` → `''`. */
export function toLtree(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .join('.');
}

/** `site.pages` → `/site/pages`; `''` → `/`. */
export function fromLtree(path: string): string {
  return `/${path
    .split('.')
    .filter((segment) => segment !== '')
    .join('/')}`;
}
