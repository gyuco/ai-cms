import type { SiteSettings } from '@ai-cms/content';

export type SiteEnv = 'prod' | 'staging';

/** Environment served by this site process (`CMS_ENV`, set by compose). */
export function siteEnv(): SiteEnv {
  return process.env.CMS_ENV === 'staging' ? 'staging' : 'prod';
}

/** Public base URL of the site, without trailing slash (`SITE_URL`). */
/** True in `next dev`: the CSP must then allow the dev tooling. */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

export function siteUrl(): string {
  const fallback = siteEnv() === 'staging' ? 'http://staging.localhost' : 'http://www.localhost';
  return (process.env.SITE_URL ?? fallback).replace(/\/+$/, '');
}

/** Internal base URL of cms-api, reached directly on the Docker network (`CMS_API_URL`). */
export function cmsApiUrl(): string {
  return (process.env.CMS_API_URL ?? 'http://cms-api:3100').replace(/\/+$/, '');
}

/**
 * Session cookie set by cms-api on every site host. Same value as `SESSION_COOKIE` in
 * `@ai-cms/auth`, repeated here so the site does not bundle the auth package.
 */
export const SESSION_COOKIE = 'cms_session';

/** Defaults used when `/site/settings` is missing or invalid, as seeded (TECHNICAL §10.5). */
export const DEFAULT_SETTINGS: SiteSettings = {
  name: 'Nuovo sito',
  lang: 'it',
  titleTemplate: '%s · Nuovo sito',
};

/** Request header set by the site proxy with the public path of the page being rendered. */
export const PATH_HEADER = 'x-cms-path';
