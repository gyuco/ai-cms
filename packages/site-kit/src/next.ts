import {
  parseLayout,
  parseMenu,
  parsePageBody,
  parseSiteSettings,
  formatIssues,
  type Layout,
  type Menu,
  type PageBody,
  type ParseResult,
  type SiteSettings,
} from '@ai-cms/content';
import { DEFAULT_SETTINGS, SESSION_COOKIE, siteEnv } from './config.ts';
import { listPublishedPages, readPublished } from './content.ts';
import {
  FOOTER_NODE,
  HEADER_NODE,
  MENU_NODE,
  SETTINGS_NODE,
  normalizePublicPath,
  pageNodeFromPath,
  publicPathFromNode,
} from './paths.ts';
import { fetchDraft } from './preview.ts';
import { sharedNodeBody } from './shared-node.ts';
import { unstable_cache } from 'next/cache';
import { cookies } from 'next/headers';
import { cache } from 'react';

/**
 * Content access for the Next.js site (`@ai-cms/site-kit/next`). Published content is kept in
 * the Next.js data cache and invalidated by `POST /__cms/revalidate`; drafts for signed-in
 * users never touch it.
 */

/** Every cached content entry carries this tag: `'*'` in a revalidation clears them all. */
export const CONTENT_TAG = 'cms';
/** The list of published pages (sitemap). */
export const PAGES_TAG = 'cms:pages';
/** Tag of the published content behind a public path, e.g. `cms:path:/chi-siamo`. */
export const pathTag = (publicPath: string) => `cms:path:${publicPath}`;

const env = siteEnv();

function cachedPublished(nodePath: string, tags: string[]) {
  return unstable_cache(() => readPublished(env, nodePath), ['cms-published', env, nodePath], {
    tags: [CONTENT_TAG, ...tags],
  })();
}

const cachedPageList = unstable_cache(() => listPublishedPages(env), ['cms-published-pages', env], {
  tags: [CONTENT_TAG, PAGES_TAG],
});

function parsed<T>(
  what: string,
  body: unknown,
  parse: (input: unknown) => ParseResult<T>,
): T | null {
  const result = parse(body);
  if (result.ok) return result.value;
  console.error(`site: contenuto non valido in ${what}\n${formatIssues(result.errors)}`);
  return null;
}

/** Body of a shared element: the draft for a signed-in user, the published one otherwise. */
async function sharedBody(nodePath: string): Promise<unknown> {
  // Reading cookies also opts the route into dynamic rendering.
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  return sharedNodeBody(nodePath, {
    env,
    session,
    published: () => cachedPublished(nodePath, []),
    onError: (message) => console.error(message),
  });
}

/** Site settings, falling back to the seeded defaults when missing or invalid. */
export const loadSettings = cache(async (): Promise<SiteSettings> => {
  const body = await sharedBody(SETTINGS_NODE);
  if (body === null) return DEFAULT_SETTINGS;
  return parsed(SETTINGS_NODE, body, parseSiteSettings) ?? DEFAULT_SETTINGS;
});

/** The main menu (a signed-in user also sees an unpublished version). */
export const loadMenu = cache(async (): Promise<Menu | null> => {
  const body = await sharedBody(MENU_NODE);
  return body === null ? null : parsed<Menu>(MENU_NODE, body, parseMenu);
});

/** Shared header and footer (a signed-in user also sees unpublished versions). */
export const loadLayouts = cache(async () => {
  const [header, footer] = await Promise.all([sharedBody(HEADER_NODE), sharedBody(FOOTER_NODE)]);
  return {
    header: header === null ? null : parsed<Layout>(HEADER_NODE, header, parseLayout),
    footer: footer === null ? null : parsed<Layout>(FOOTER_NODE, footer, parseLayout),
  };
});

export interface LoadedPage {
  publicPath: string;
  nodePath: string;
  body: PageBody;
  /** True when a signed-in user sees a version that is not the published one. */
  draft: boolean;
}

/**
 * The page at a public path, or null for a 404. With a `cms_session` cookie the latest
 * version is asked to cms-api (FR-150); an invalid session or a missing permission falls
 * back to the published page, as for any visitor.
 */
export const loadPage = cache(async (path: string): Promise<LoadedPage | null> => {
  const publicPath = normalizePublicPath(path);
  const nodePath = pageNodeFromPath(publicPath);
  // Reading cookies also opts the route into dynamic rendering.
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!nodePath) return null;

  if (session) {
    const draft = await fetchDraft({ publicPath, env, sessionToken: session });
    if (draft.status === 'not-found') return null;
    if (draft.status === 'ok') {
      const body = parsed(nodePath, draft.body, parsePageBody);
      if (body) return { publicPath, nodePath, body, draft: !draft.published };
    }
    if (draft.status === 'error')
      console.error(`site: anteprima non disponibile: ${draft.message}`);
  }

  const entry = await cachedPublished(nodePath, [pathTag(publicPath)]);
  if (!entry || entry.kind !== 'page') return null;
  const body = parsed(nodePath, entry.body, parsePageBody);
  if (!body) return null;
  return { publicPath, nodePath, body, draft: false };
});

export interface PublishedPage {
  publicPath: string;
  body: PageBody;
  publishedAt: Date;
}

/** Every valid published page (sitemap). */
export async function loadPublishedPages(): Promise<PublishedPage[]> {
  const pages: PublishedPage[] = [];
  for (const entry of await cachedPageList()) {
    const publicPath = publicPathFromNode(entry.path);
    const body = parsed(entry.path, entry.body, parsePageBody);
    if (publicPath && body) {
      // The data cache stores JSON: dates come back as strings.
      pages.push({ publicPath, body, publishedAt: new Date(entry.publishedAt) });
    }
  }
  return pages;
}
