import { describe, expect, it } from 'vitest';
import {
  normalizePublicPath,
  pageNodeFromPath,
  pageNodeFromSegments,
  publicPathFromNode,
  treePath,
} from './paths.ts';

describe('page paths', () => {
  it('maps public paths to page nodes', () => {
    expect(pageNodeFromSegments([])).toBe('site.pages.index');
    expect(pageNodeFromPath('/')).toBe('site.pages.index');
    expect(pageNodeFromPath('/chi-siamo')).toBe('site.pages.chi-siamo');
    expect(pageNodeFromPath('/blog/primo/')).toBe('site.pages.blog.primo');
  });

  it('rejects paths that cannot name a page', () => {
    expect(pageNodeFromPath('/index')).toBeNull();
    expect(pageNodeFromPath('/Chi-Siamo')).toBeNull();
    expect(pageNodeFromPath('/a.b')).toBeNull();
    expect(pageNodeFromPath('/-x')).toBeNull();
    expect(pageNodeFromPath('/%2e%2e')).toBeNull();
    expect(pageNodeFromPath('chi-siamo')).toBeNull();
  });

  it('maps page nodes back to public paths', () => {
    expect(publicPathFromNode('site.pages.index')).toBe('/');
    expect(publicPathFromNode('site.pages.blog.primo')).toBe('/blog/primo');
    expect(publicPathFromNode('site.settings')).toBeNull();
  });

  it('formats tree paths and normalizes public paths', () => {
    expect(treePath('site.pages.index')).toBe('/site/pages/index');
    expect(normalizePublicPath('/blog/primo/')).toBe('/blog/primo');
    expect(normalizePublicPath('')).toBe('/');
  });
});
