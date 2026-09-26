import { coreDatabaseUrl } from '@ai-cms/db';
import postgres from 'postgres';
import type { SiteEnv } from './config.ts';
import { PAGES_ROOT } from './paths.ts';

/** The content database could not be reached or queried. */
export class ContentUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Contenuti non disponibili: il database non risponde.', { cause });
    this.name = 'ContentUnavailableError';
  }
}

export interface PublishedEntry {
  /** ltree path of the node, e.g. `site.pages.chi-siamo`. */
  path: string;
  kind: string;
  body: unknown;
  version: number;
  publishedAt: Date;
}

// One pool per process, even when bundlers load this module more than once (Next.js
// bundles the proxy and the app separately).
const store = globalThis as typeof globalThis & { __cmsContentDb?: postgres.Sql };

/**
 * Lazy connection pool as `site_content_ro`, which can only read the `published_content`
 * view (TECHNICAL §5.3). Created on first use, so that builds never connect.
 */
function db(): postgres.Sql {
  store.__cmsContentDb ??= postgres(coreDatabaseUrl('site_ro'), {
    max: 5,
    connect_timeout: 5,
    idle_timeout: 60,
    onnotice: () => {},
  });
  return store.__cmsContentDb;
}

interface Row {
  path: string;
  kind: string;
  body: unknown;
  version: string | number;
  published_at: Date;
}

function toEntry(row: Row): PublishedEntry {
  return {
    path: row.path,
    kind: row.kind,
    body: row.body,
    version: Number(row.version),
    publishedAt: row.published_at,
  };
}

async function query(run: (sql: postgres.Sql) => Promise<Row[]>): Promise<PublishedEntry[]> {
  let rows: Row[];
  try {
    rows = await run(db());
  } catch (error) {
    throw new ContentUnavailableError(error);
  }
  return rows.map(toEntry);
}

/** Published content of one node in `env`, or null if it is not published. */
export async function readPublished(
  env: SiteEnv,
  nodePath: string,
): Promise<PublishedEntry | null> {
  const [entry] = await query(
    (sql) => sql<Row[]>`
      SELECT path::text AS path, kind, body, version, published_at
      FROM published_content
      WHERE env = ${env} AND path = ${nodePath}::ltree`,
  );
  return entry ?? null;
}

/** All published pages in `env`, in path order. */
export async function listPublishedPages(env: SiteEnv): Promise<PublishedEntry[]> {
  return query(
    (sql) => sql<Row[]>`
      SELECT path::text AS path, kind, body, version, published_at
      FROM published_content
      WHERE env = ${env} AND kind = 'page' AND path <@ ${PAGES_ROOT}::ltree
      ORDER BY path`,
  );
}

/** Closes the pool (tests and graceful shutdown). */
export async function closeContentDb(): Promise<void> {
  const current = store.__cmsContentDb;
  store.__cmsContentDb = undefined;
  await current?.end({ timeout: 5 });
}
