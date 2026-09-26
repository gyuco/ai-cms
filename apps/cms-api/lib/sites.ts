import type { Env } from './http.ts';

/** Public base URL of each environment's site, used in emails and prod/staging sign-on. */
export function siteUrl(env: Env): string {
  return env === 'staging'
    ? (process.env.SITE_URL_STAGING ?? 'http://staging.localhost')
    : (process.env.SITE_URL_PROD ?? 'http://www.localhost');
}
