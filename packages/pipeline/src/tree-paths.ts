/** Makes a file-name segment usable as an ltree label. */
function toLabel(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * The tree node (ltree path, TECHNICAL §6.6) a file of the site repository belongs to.
 * Coarse for now: dynamic pages map to their page node, everything else to its section.
 */
export function treePathForFile(file: string): string {
  const parts = file.split('/').filter(Boolean);
  const [top, second, third] = parts;
  if (top === 'app' && second === '(dynamic)') {
    if (parts.length >= 4 && third) {
      const label = toLabel(third);
      if (/[A-Za-z0-9]/.test(label)) return `site.pages.${label}`;
    }
    return 'site.pages';
  }
  switch (top) {
    case 'components':
      return 'site.components';
    case 'api':
      return 'code.api';
    case 'lib':
      return 'code.lib';
    case 'db':
      return 'data.collections';
    default:
      return 'code';
  }
}

/** Distinct tree paths touched by a set of files, sorted. */
export function touchedTreePaths(files: readonly string[]): string[] {
  return [...new Set(files.map(treePathForFile))].sort();
}

/** True when one path is equal to, an ancestor of, or a descendant of the other. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}
