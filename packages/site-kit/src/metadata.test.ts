import type { PageBody, SiteSettings } from '@ai-cms/content';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './config.ts';
import { isIndexable, isNoindex, pageLang, pageMetadata, pageTitle } from './metadata.ts';

const site = 'http://www.localhost';
const settings: SiteSettings = {
  ...DEFAULT_SETTINGS,
  favicon: 'favicon_asset',
  socialImage: '/social.png',
};
const empty: PageBody = { meta: {}, blocks: [] };

describe('pageTitle and pageLang', () => {
  it('formats the title with the site template; untitled pages use the site name', () => {
    expect(pageTitle({ meta: { title: 'Chi siamo' } }, settings)).toBe('Chi siamo · Nuovo sito');
    expect(pageTitle(empty, settings)).toBe('Nuovo sito');
  });

  it('prefers the page language', () => {
    expect(pageLang({ meta: { lang: 'en' } }, settings)).toBe('en');
    expect(pageLang(empty, settings)).toBe('it');
    expect(pageLang(null, settings)).toBe('it');
  });
});

describe('pageMetadata', () => {
  it('fills the head from the page meta and the site defaults', () => {
    const metadata = pageMetadata({
      page: {
        meta: { title: 'Chi siamo', description: 'Chi siamo e cosa facciamo.', robots: 'noindex' },
        blocks: [],
      },
      settings,
      publicPath: '/chi-siamo',
      siteUrl: site,
    });
    expect(metadata).toMatchObject({
      title: { absolute: 'Chi siamo · Nuovo sito' },
      description: 'Chi siamo e cosa facciamo.',
      robots: 'noindex',
      alternates: { canonical: 'http://www.localhost/chi-siamo' },
      icons: { icon: '/_cms/assets/favicon_asset' },
      openGraph: {
        type: 'website',
        url: 'http://www.localhost/chi-siamo',
        siteName: 'Nuovo sito',
        title: 'Chi siamo · Nuovo sito',
        description: 'Chi siamo e cosa facciamo.',
        locale: 'it',
        images: ['http://www.localhost/social.png'],
      },
    });
  });

  it('uses the Open Graph overrides and an explicit canonical URL', () => {
    const metadata = pageMetadata({
      page: {
        meta: {
          lang: 'en-GB',
          canonical: 'https://example.com/about',
          og: { title: 'About', description: 'About us', image: 'https://cdn.example.com/a.png' },
        },
        blocks: [],
      },
      settings: DEFAULT_SETTINGS,
      publicPath: '/about',
      siteUrl: site,
    });
    expect(metadata.title).toEqual({ absolute: 'Nuovo sito' });
    expect(metadata.description).toBeUndefined();
    expect(metadata.alternates).toEqual({ canonical: 'https://example.com/about' });
    expect(metadata.openGraph).toMatchObject({
      title: 'About',
      description: 'About us',
      locale: 'en_GB',
      images: ['https://cdn.example.com/a.png'],
    });
  });

  it('forces noindex when asked', () => {
    const metadata = pageMetadata({
      page: { meta: { robots: 'index,follow' }, blocks: [] },
      settings,
      publicPath: '/',
      siteUrl: site,
      noindex: true,
    });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

describe('indexability', () => {
  it('recognizes noindex directives', () => {
    expect(isNoindex(undefined)).toBe(false);
    expect(isNoindex('index,follow')).toBe(false);
    expect(isNoindex('noindex, follow')).toBe(true);
    expect(isNoindex('NONE')).toBe(true);
  });

  it('keeps out pages that are noindex or canonical elsewhere', () => {
    expect(isIndexable(empty, '/', site)).toBe(true);
    expect(isIndexable({ meta: { robots: 'noindex' } }, '/x', site)).toBe(false);
    expect(isIndexable({ meta: { canonical: '/y' } }, '/x', site)).toBe(false);
    expect(isIndexable({ meta: { canonical: '/x' } }, '/x', site)).toBe(true);
  });
});
