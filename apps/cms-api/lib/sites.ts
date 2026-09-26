import { pageUrl } from '@ai-cms/content';
import type { PublishHook } from '@ai-cms/content/service';
import type { Env } from './http.ts';
import { revalidateSite as requestSiteRevalidation, siteInternalUrl } from './revalidate.ts';

export { siteInternalUrl };

/** Public base URL of each environment's site, used in emails and prod/staging sign-on. */
export function siteUrl(env: Env): string {
  return env === 'staging'
    ? (process.env.SITE_URL_STAGING ?? 'http://staging.localhost')
    : (process.env.SITE_URL_PROD ?? 'http://www.localhost');
}

/**
 * Asks the site to regenerate what a publication changed (TECHNICAL §9). Pages map to their
 * URL; shared elements (settings, layouts, menus, assets) appear on every page, so they ask
 * for the whole site ('*'). Errors surface as the publication's `hookError`.
 */
export const revalidateSite: PublishHook = async (paths, env) => {
  const urls = new Set<string>();
  for (const path of paths) urls.add(pageUrl(path) ?? '*');
  if (urls.size === 0) return;
  const result = await requestSiteRevalidation(env, urls.has('*') ? ['*'] : [...urls]);
  if (!result.ok) throw new Error(`rigenerazione del sito non riuscita: ${result.error ?? ''}`);
};

/**
 * After a page was renamed, moved or deleted: every URL under it changed and menus may
 * point to it, so the whole site is regenerated. Returns `hookError` like a publication.
 */
export async function revalidatePages(env: Env): Promise<{ hookError?: string }> {
  try {
    await revalidateSite(['/site/settings'], env);
    return {};
  } catch (error) {
    return { hookError: error instanceof Error ? error.message : String(error) };
  }
}
