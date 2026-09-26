import { describe, expect, it } from 'vitest';
import { pageNodePath, pageUrl } from './pages.ts';

describe('pageNodePath', () => {
  it('maps the home and nested pages', () => {
    expect(pageNodePath('/')).toBe('site.pages.index');
    expect(pageNodePath('')).toBe('site.pages.index');
    expect(pageNodePath('/chi-siamo')).toBe('site.pages.chi-siamo');
    expect(pageNodePath('/chi-siamo/team/')).toBe('site.pages.chi-siamo.team');
    expect(pageNodePath('/blog?x=1#top')).toBe('site.pages.blog');
  });

  it('rejects paths that cannot be pages', () => {
    expect(pageNodePath('/Chi-Siamo')).toBeNull();
    expect(pageNodePath('/_cms/login')).toBeNull();
    expect(pageNodePath('/a.html')).toBeNull();
    expect(pageNodePath('/%E0%A4%A')).toBeNull();
  });
});

describe('pageUrl', () => {
  it('is the inverse of pageNodePath', () => {
    expect(pageUrl('site.pages.index')).toBe('/');
    expect(pageUrl('/site/pages/index')).toBe('/');
    expect(pageUrl('/site/pages/chi-siamo/team')).toBe('/chi-siamo/team');
    expect(pageUrl('site.layouts.header')).toBeNull();
    expect(pageUrl('/site/pages')).toBeNull();
  });
});
