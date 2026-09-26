import {
  requestRevalidation,
  revalidateToken,
  type RevalidationResult,
} from '@ai-cms/site-kit/data';
import type { Env } from './http.ts';

/** Internal URL of each environment's site on the Docker network. */
export function siteInternalUrl(env: Env): string {
  return env === 'staging'
    ? (process.env.SITE_INTERNAL_URL_STAGING ?? 'http://site-staging:3000')
    : (process.env.SITE_INTERNAL_URL_PROD ?? 'http://site-prod:3000');
}

/**
 * Asks the site of `env` to regenerate public paths after a publication (TECHNICAL §9, NFR-03):
 * page paths such as `/chi-siamo`, or `'*'` for layouts, menus and settings. Never throws: a
 * failed revalidation must not undo a publication, the caller logs the result.
 */
export async function revalidateSite(env: Env, paths: string[]): Promise<RevalidationResult> {
  if (paths.length === 0) return { ok: true };
  let token: string;
  try {
    token = revalidateToken();
  } catch (error) {
    return { ok: false, error: `revalidate_token non disponibile: ${String(error)}` };
  }
  const result = await requestRevalidation({ siteUrl: siteInternalUrl(env), token, paths });
  if (!result.ok) {
    console.error(`cms-api: revalidazione del sito ${env} non riuscita: ${result.error ?? ''}`);
  }
  return result;
}
