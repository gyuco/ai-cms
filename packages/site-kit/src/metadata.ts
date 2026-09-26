import type { PageBody, SiteSettings } from '@ai-cms/content';
import type { Metadata } from 'next';
import { resolveImageSrc, type RenderOptions } from './render/options.ts';

/** Page title through the site template; a page without a title shows the site name alone. */
export function pageTitle(page: Pick<PageBody, 'meta'>, settings: SiteSettings): string {
  const title = page.meta.title;
  if (!title) return settings.name;
  return settings.titleTemplate.replaceAll('%s', title);
}

/** Language of a page: its own `meta.lang`, else the site's. */
export function pageLang(page: Pick<PageBody, 'meta'> | null, settings: SiteSettings): string {
  return page?.meta.lang ?? settings.lang;
}

/** Absolute URL on the site for a root-relative path or an absolute URL. */
export function absoluteUrl(pathOrUrl: string, siteUrl: string): string {
  return new URL(pathOrUrl, siteUrl).toString();
}

/** Canonical URL of a page: `meta.canonical` if set, else its own address. */
export function canonicalUrl(page: Pick<PageBody, 'meta'>, publicPath: string, siteUrl: string) {
  return absoluteUrl(page.meta.canonical ?? publicPath, siteUrl);
}

/** True when the robots directives keep the page out of search engines. */
export function isNoindex(robots: string | undefined): boolean {
  if (!robots) return false;
  return robots
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .some((token) => token === 'noindex' || token === 'none');
}

/** Whether a page belongs in the sitemap: indexable and canonical for its own address. */
export function isIndexable(page: Pick<PageBody, 'meta'>, publicPath: string, siteUrl: string) {
  if (isNoindex(page.meta.robots)) return false;
  return canonicalUrl(page, publicPath, siteUrl) === absoluteUrl(publicPath, siteUrl);
}

export interface PageMetadataInput {
  page: PageBody;
  settings: SiteSettings;
  /** Public path of the page, e.g. `/chi-siamo`. */
  publicPath: string;
  /** Public base URL of the site, e.g. `http://www.localhost`. */
  siteUrl: string;
  /** Keeps the page out of search engines whatever its meta says (e.g. on staging). */
  noindex?: boolean;
  options?: RenderOptions;
}

/** `<head>` of a content page from its `meta` and the site defaults (TECHNICAL §11.2). */
export function pageMetadata({
  page,
  settings,
  publicPath,
  siteUrl,
  noindex,
  options,
}: PageMetadataInput): Metadata {
  const { meta } = page;
  const title = pageTitle(page, settings);
  const canonical = canonicalUrl(page, publicPath, siteUrl);
  const description = meta.og?.description ?? meta.description;
  const image = meta.og?.image ?? settings.socialImage;
  const metadata: Metadata = {
    metadataBase: new URL(siteUrl),
    title: { absolute: title },
    alternates: { canonical },
    openGraph: {
      type: 'website',
      url: canonical,
      siteName: settings.name,
      title: meta.og?.title ?? title,
      locale: pageLang(page, settings).replace('-', '_'),
      ...(description ? { description } : {}),
      ...(image ? { images: [absoluteUrl(resolveImageSrc(image, options), siteUrl)] } : {}),
    },
  };
  if (meta.description) metadata.description = meta.description;
  if (noindex) metadata.robots = { index: false, follow: false };
  else if (meta.robots) metadata.robots = meta.robots;
  if (settings.favicon) metadata.icons = { icon: resolveImageSrc(settings.favicon, options) };
  return metadata;
}
