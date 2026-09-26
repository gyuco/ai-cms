import { AuthzError, type Env, type Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import {
  authorizeOrAudit,
  lookupNode,
  nodeTarget,
  toPublicPath,
  type Executor,
  type TreeNode,
} from '@ai-cms/tree';
import { eq } from 'drizzle-orm';
import { pageNodePath } from '../pages.ts';
import { latestVersion, publishedVersionId } from './versions.ts';

const { contentVersions } = schema;

export interface PageStatus {
  /** Number of the latest saved version, null when the page has no content yet. */
  latestVersion: number | null;
  /** Number of the version published in this environment, null when not published. */
  publishedVersion: number | null;
  /** True when the latest version is not the published one. */
  hasDraft: boolean;
}

export interface PageContext {
  node: {
    /** Public node path (`/site/pages/chi-siamo`), null when the URL cannot be a page. */
    path: string | null;
    kind: TreeNode['kind'] | null;
    exists: boolean;
    /** Tree version of the node, for optimistic concurrency on rename, move and delete. */
    version: number | null;
  };
  /** Null when the node does not exist, is not a page or cannot be read. */
  page: PageStatus | null;
}

/** Version number of a `content_versions` row. */
async function versionNumber(db: Executor, id: number | null): Promise<number | null> {
  if (id === null) return null;
  const [row] = await db
    .select({ version: contentVersions.version })
    .from(contentVersions)
    .where(eq(contentVersions.id, id));
  return row?.version ?? null;
}

/** Publication state of a node in `env`, without authorization. */
export async function pageStatus(db: Executor, node: TreeNode, env: Env): Promise<PageStatus> {
  const [latest, publishedId] = await Promise.all([
    latestVersion(db, node.id, env),
    publishedVersionId(db, node.id, env),
  ]);
  const published = await versionNumber(db, publishedId);
  const latestNumber = latest?.version ?? null;
  return {
    latestVersion: latestNumber,
    publishedVersion: published,
    hasDraft: latestNumber !== null && latestNumber !== published,
  };
}

/**
 * The page behind a site URL, as the widget sees it (TECHNICAL §10.3): whether the node
 * exists and, when it can be read, its publication state.
 */
export async function getPageContext(
  db: Executor,
  principal: Principal,
  env: Env,
  urlPath: string,
): Promise<PageContext> {
  const ltreePath = pageNodePath(urlPath);
  if (ltreePath === null) {
    return { node: { path: null, kind: null, exists: false, version: null }, page: null };
  }
  const node = await lookupNode(db, ltreePath, env);
  if (!node) {
    return {
      node: { path: toPublicPath(ltreePath), kind: null, exists: false, version: null },
      page: null,
    };
  }
  const info = { path: node.path, kind: node.kind, exists: true, version: node.version };
  if (node.kind !== 'page') return { node: info, page: null };
  try {
    await authorizeOrAudit(db, principal, 'read', nodeTarget(node), env, 'content.read');
  } catch (error) {
    if (error instanceof AuthzError) return { node: info, page: null };
    throw error;
  }
  return { node: info, page: await pageStatus(db, node, env) };
}
