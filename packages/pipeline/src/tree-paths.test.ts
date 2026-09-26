import { describe, expect, it } from 'vitest';
import { pathsOverlap, touchedTreePaths, treePathForFile } from './tree-paths.ts';

describe('treePathForFile', () => {
  it.each([
    ['app/(dynamic)/catalogo/page.tsx', 'site.pages.catalogo'],
    ['app/(dynamic)/catalogo/[slug]/page.tsx', 'site.pages.catalogo'],
    ['app/(dynamic)/chi-siamo/page.tsx', 'site.pages.chi-siamo'],
    ['app/(dynamic)/[id]/page.tsx', 'site.pages._id_'],
    ['app/(dynamic)/layout.tsx', 'site.pages'],
    ['app/(dynamic)/(group)/x/page.tsx', 'site.pages._group_'],
    ['components/Card.tsx', 'site.components'],
    ['components/ui/Button.tsx', 'site.components'],
    ['api/contatti.ts', 'code.api'],
    ['lib/format.ts', 'code.lib'],
    ['db/schema/prodotti.ts', 'data.collections'],
    ['db/migrations/0001.sql', 'data.collections'],
    ['app/layout.tsx', 'code'],
    ['package.json', 'code'],
    ['pnpm-lock.yaml', 'code'],
  ])('%s → %s', (file, path) => {
    expect(treePathForFile(file)).toBe(path);
  });
});

describe('touchedTreePaths', () => {
  it('deduplicates and sorts', () => {
    expect(
      touchedTreePaths(['lib/a.ts', 'api/x.ts', 'lib/b.ts', 'app/(dynamic)/blog/page.tsx']),
    ).toEqual(['code.api', 'code.lib', 'site.pages.blog']);
    expect(touchedTreePaths([])).toEqual([]);
  });
});

describe('pathsOverlap', () => {
  it('matches equal, ancestor and descendant paths only', () => {
    expect(pathsOverlap('code', 'code.api')).toBe(true);
    expect(pathsOverlap('code.api', 'code')).toBe(true);
    expect(pathsOverlap('code.api', 'code.api')).toBe(true);
    expect(pathsOverlap('code.api', 'code.lib')).toBe(false);
    expect(pathsOverlap('site.pages.blog', 'site.pages.blogs')).toBe(false);
  });
});
