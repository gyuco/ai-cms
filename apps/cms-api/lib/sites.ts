import { pageUrl } from '@ai-cms/content';
import type { PublishHook } from '@ai-cms/content/service';
import { readSecret } from '@ai-cms/db';
import type { Env } from './http.ts';

/** Public base URL of each environment's site, used in emails and prod/staging sign-on. */
export function siteUrl(env: Env): string {
  return env === 'staging'
    ? (process.env.SITE_URL_STAGING ?? 'http://staging.localhost')
    : (process.env.SITE_URL_PROD ?? 'http://www.localhost');
}

/** Base URL of each environment's site on the internal network (not through Caddy). */
export function siteInternalUrl(env: Env): string {
  return env === 'staging'
    ? (process.env.SITE_INTERNAL_URL_STAGING ?? 'http://site-staging:3000')
    : (process.env.SITE_INTERNAL_URL_PROD ?? 'http://site-prod:3000');
}

let revalidateToken: string | undefined;

/**
 * Asks the site to regenerate what a publication changed (TECHNICAL §9). Pages map to their
 * URL; shared elements (settings, layouts, menus) appear on every page, so they ask for the
 * whole site (`all`). Errors surface as the publication's `hookError`.
 */
export const revalidateSite: PublishHook = async (paths, env) => {
  const urls = new Set<string>();
  let all = false;
  for (const path of paths) {
    const url = pageUrl(path);
    if (url) urls.add(url);
    else all = true;
  }
  try {
    revalidateToken ??= readSecret('revalidate_token');
  } catch {
    throw new Error('manca il token per la rigenerazione del sito (revalidate_token)');
  }
  let response: Response;
  try {
    response = await fetch(`${siteInternalUrl(env)}/__cms/revalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${revalidateToken}` },
      body: JSON.stringify({ paths: [...urls], all }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('il sito non è raggiungibile per la rigenerazione');
  }
  if (!response.ok) {
    throw new Error(`il sito ha risposto ${String(response.status)} alla rigenerazione`);
  }
};
