import { absoluteUrl, isIndexable, siteEnv, siteUrl } from '@ai-cms/site-kit';
import type { MetadataRoute } from 'next';
import { connection } from 'next/server';
import { loadPublishedPages } from '../lib/cms.ts';

/** Published, indexable pages (FR-167). Staging has no sitemap entries. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  if (siteEnv() === 'staging') return [];
  const base = siteUrl();
  const pages = await loadPublishedPages();
  return pages
    .filter((page) => isIndexable(page.body, page.publicPath, base))
    .map((page) => ({ url: absoluteUrl(page.publicPath, base), lastModified: page.publishedAt }));
}
