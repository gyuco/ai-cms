import { AuthzError, type Env, type Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import {
  ValidationError,
  authorizeOrAudit,
  createNode,
  lookupNode,
  nodeTarget,
  parsePath,
  requireNode,
  toPublicPath,
  type Executor,
  type TreeNode,
} from '@ai-cms/tree';
import { eq, inArray } from 'drizzle-orm';
import type { PageBody, PageMeta } from '../documents.ts';
import { pageNodePath, pageUrl } from '../pages.ts';
import {
  insertVersion,
  latestVersion,
  listVersions,
  publishedVersionId,
  saveDraft,
  type ContentVersion,
  type SaveOptions,
  type VersionInfo,
} from './versions.ts';

const { contentVersions, users } = schema;

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

export interface PageVersionInfo extends VersionInfo {
  /** Display name (or username) of the author, null if the user no longer exists. */
  authorName: string | null;
}

export interface PageDetails {
  node: { path: string; url: string | null; version: number };
  status: PageStatus;
  /** Metadata of the latest version; empty when the page has no content yet. */
  meta: PageMeta;
  versions: PageVersionInfo[];
}

/** Names of the given users, by uid. */
export async function userNames(db: Executor, uids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(uids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ uid: users.uid, username: users.username, displayName: users.displayName })
    .from(users)
    .where(inArray(users.uid, unique));
  return new Map(rows.map((row) => [row.uid, row.displayName || row.username]));
}

function requirePage(node: TreeNode): void {
  if (node.kind !== 'page') {
    throw new ValidationError(`${node.path} non è una pagina (tipo "${node.kind}").`);
  }
}

function pageBody(version: ContentVersion | null): PageBody {
  const body = version?.body as Partial<PageBody> | undefined;
  return { meta: body?.meta ?? {}, blocks: body?.blocks ?? [] };
}

/** Everything the Page tab shows (E7.7): state, metadata and versions with their authors. */
export async function getPageDetails(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
): Promise<PageDetails> {
  const node = await requireNode(db, parsePath(path), env);
  requirePage(node);
  // listVersions authorizes the read (and audits a denial).
  const versions = await listVersions(db, principal, env, node.path);
  const names = await userNames(
    db,
    versions.map((v) => v.authorUid),
  );
  const latest = await latestVersion(db, node.id, env);
  return {
    node: { path: node.path, url: pageUrl(node.ltreePath), version: node.version },
    status: await pageStatus(db, node, env),
    meta: pageBody(latest).meta,
    versions: versions.map((v) => ({ ...v, authorName: names.get(v.authorUid) ?? null })),
  };
}

/** Drops blank strings and empty objects, so a cleared form field removes the value. */
export function dropBlank(value: unknown): unknown {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, dropBlank(item)] as const)
    .filter(([, item]) => item !== undefined);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * Saves new metadata (title, description, social) as a new version, keeping the blocks of
 * the latest one. Blank fields are removed. `expectedVersion` is the content version the
 * editor started from.
 */
export async function savePageMeta(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  meta: unknown,
  options: SaveOptions = {},
): Promise<ContentVersion> {
  const ltreePath = parsePath(path);
  return db.transaction(async (tx) => {
    const node = await requireNode(tx, ltreePath, env, { forUpdate: true });
    requirePage(node);
    await authorizeOrAudit(db, principal, 'write', nodeTarget(node), env, 'content.write');
    const body = pageBody(await latestVersion(tx, node.id, env));
    return insertVersion(
      tx,
      principal,
      env,
      node,
      { ...body, meta: dropBlank(meta) ?? {} },
      options,
      'content.write',
      { fields: 'meta' },
    );
  });
}

export interface CreatePageInput {
  /** Node name, which is also the last part of the URL. */
  name: string;
  title?: string | null;
}

/** Creates a page under `parentPath` with an empty first version (a draft to publish). */
export async function createPage(
  db: Executor,
  principal: Principal,
  env: Env,
  parentPath: string,
  input: CreatePageInput,
): Promise<{ node: TreeNode; url: string | null; version: ContentVersion }> {
  const parent = parsePath(parentPath);
  if (parent !== 'site.pages' && !parent.startsWith('site.pages.')) {
    throw new ValidationError('Le pagine si creano solo dentro /site/pages.');
  }
  const title = input.title?.trim();
  return db.transaction(async (tx) => {
    const node = await createNode(tx, principal, env, parent, { name: input.name, kind: 'page' });
    const version = await saveDraft(tx, principal, env, node.path, {
      meta: title ? { title } : {},
      blocks: [],
    });
    return { node, url: pageUrl(node.ltreePath), version };
  });
}
