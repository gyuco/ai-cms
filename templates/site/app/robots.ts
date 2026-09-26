import { siteEnv, siteUrl } from '@ai-cms/site-kit';
import type { MetadataRoute } from 'next';
import { connection } from 'next/server';

/** `robots.txt` (FR-167): staging is never indexed; production points to the sitemap. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  // SITE_URL and CMS_ENV are read at request time, not at build time.
  await connection();
  if (siteEnv() === 'staging') {
    return { rules: { userAgent: '*', disallow: '/' } };
  }
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/_cms/', '/__cms/'] },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
