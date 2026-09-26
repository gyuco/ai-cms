import { describe, expect, it } from 'vitest';
import { fromLtree, isUnder, toLtree } from './paths.ts';

describe('isUnder', () => {
  it.each([
    ['site.pages.blog', '', true],
    ['', '', true],
    ['site', 'site', true],
    ['site.pages.blog', 'site.pages', true],
    ['site.pagesx', 'site.pages', false],
    ['site', 'site.pages', false],
    ['data', 'site', false],
    ['', 'site', false],
  ])('%j under %j → %s', (path, prefix, expected) => {
    expect(isUnder(path, prefix)).toBe(expected);
  });
});

describe('toLtree / fromLtree', () => {
  it.each([
    ['/site/pages', 'site.pages'],
    ['/', ''],
    ['/site/pages/', 'site.pages'],
    ['site', 'site'],
  ])('toLtree(%j) = %j', (path, ltree) => {
    expect(toLtree(path)).toBe(ltree);
  });

  it.each([
    ['site.pages', '/site/pages'],
    ['', '/'],
    ['system', '/system'],
  ])('fromLtree(%j) = %j', (ltree, path) => {
    expect(fromLtree(ltree)).toBe(path);
  });

  it('round-trips', () => {
    expect(fromLtree(toLtree('/site/pages/blog'))).toBe('/site/pages/blog');
  });
});
