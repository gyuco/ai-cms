import type { Env, Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import {
  ValidationError,
  authorizeOrAudit,
  deleteNode,
  listChildren,
  moveNode,
  nodeTarget,
  parsePath,
  renameNode,
  requireNode,
  type Executor,
  type TreeNode,
  type VersionOptions,
} from '@ai-cms/tree';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SiteSettings } from '../documents.ts';
import { PAGES_PATH, pageUrl } from '../pages.ts';
import { pageStatus, type PageStatus } from './pages.ts';
import { LAYOUTS_PATH, MENUS_PATH, SITE_SETTINGS_PATH } from './shared.ts';
import {
  insertVersion,
  latestVersion,
  publishVersion,
  type PublishHook,
  type SaveOptions,
} from './versions.ts';

const { contentVersions, nodes, publications } = schema;

export interface TreeEntry {
  path: string;
  name: string;
  kind: TreeNode['kind'];
  /** Site URL, for pages. */
  url: string | null;
  /** Title of the latest version, for pages. */
  title: string | null;
  hasChildren: boolean;
  /** Tree version, for rename, move and delete. */
  version: number;
  status: PageStatus;
}

function isPagePath(ltreePath: string): boolean {
  return ltreePath === PAGES_PATH || ltreePath.startsWith(`${PAGES_PATH}.`);
}

function requirePagesArea(ltreePath: string, what: string): void {
  if (!isPagePath(ltreePath)) {
    throw new ValidationError(`${what} deve stare dentro /site/pages.`);
  }
}

/**
 * Children of a folder of the site (Site tab, E7.8), with what the tree needs to show
 * them without a request per node: title, publication state, whether they have children.
 */
export async function listTreeEntries(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
): Promise<TreeEntry[]> {
  const children = await listChildren(db, principal, env, path);
  if (children.length === 0) return [];
  const ids = children.map((child) => child.id);

  const latest = await db
    .selectDistinctOn([contentVersions.nodeId], {
      nodeId: contentVersions.nodeId,
      version: contentVersions.version,
      title: sql<string | null>`${contentVersions.body} -> 'meta' ->> 'title'`,
    })
    .from(contentVersions)
    .where(and(inArray(contentVersions.nodeId, ids), eq(contentVersions.env, env)))
    .orderBy(contentVersions.nodeId, desc(contentVersions.version));
  const published = await db
    .select({ nodeId: publications.nodeId, version: contentVersions.version })
    .from(publications)
    .innerJoin(contentVersions, eq(contentVersions.id, publications.versionId))
    .where(
      and(
        inArray(publications.nodeId, ids),
        eq(publications.env, env),
        eq(publications.status, 'published'),
      ),
    );
  const withChildren = await db
    .selectDistinct({ parentId: nodes.parentId })
    .from(nodes)
    .where(
      and(
        inArray(nodes.parentId, ids),
        isNull(nodes.deletedAt),
        sql`${nodes.env} IN (${env}, 'both')`,
      ),
    );

  const latestOf = new Map(latest.map((row) => [row.nodeId, row]));
  const publishedOf = new Map(published.map((row) => [row.nodeId, row.version]));
  const parents = new Set(withChildren.map((row) => row.parentId));
  return children.map((child) => {
    const last = latestOf.get(child.id);
    const latestVersion = last?.version ?? null;
    const publishedVersion = publishedOf.get(child.id) ?? null;
    return {
      path: child.path,
      name: child.name,
      kind: child.kind,
      url: child.kind === 'page' ? pageUrl(child.ltreePath) : null,
      title: child.kind === 'page' ? (last?.title ?? null) : null,
      hasChildren: parents.has(child.id),
      version: child.version,
      status: {
        latestVersion,
        publishedVersion,
        hasDraft: latestVersion !== null && latestVersion !== publishedVersion,
      },
    };
  });
}

/** Renames a page (its URL changes, with the URLs of the pages inside it). */
export async function renamePage(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  name: string,
  options: VersionOptions = {},
): Promise<TreeNode> {
  requirePagesArea(parsePath(path), 'La pagina');
  return renameNode(db, principal, env, path, name, options);
}

/** Moves a page under another page (or to the top level, `/site/pages`). */
export async function movePage(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  newParentPath: string,
  options: VersionOptions = {},
): Promise<TreeNode> {
  requirePagesArea(parsePath(path), 'La pagina');
  requirePagesArea(parsePath(newParentPath), 'La destinazione');
  return moveNode(db, principal, env, path, newParentPath, options);
}

/** Deletes a page and the pages inside it (they can be restored). */
export async function deletePage(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  options: VersionOptions = {},
): Promise<TreeNode> {
  requirePagesArea(parsePath(path), 'La pagina');
  return deleteNode(db, principal, env, path, options);
}

export interface SharedEntry {
  name: string;
  path: string;
  status: PageStatus;
}

export interface SiteOverview {
  /** Latest saved settings (null if never saved) and the version they come from. */
  settings: { value: SiteSettings | null; version: number | null; status: PageStatus };
  layouts: SharedEntry[];
  menus: SharedEntry[];
}

async function sharedEntries(
  db: Executor,
  principal: Principal,
  env: Env,
  folder: string,
): Promise<SharedEntry[]> {
  const entries = await listTreeEntries(db, principal, env, folder);
  return entries.map((entry) => ({ name: entry.name, path: entry.path, status: entry.status }));
}

/** Settings, layouts and menus of the site, for the Site tab. */
export async function getSiteOverview(
  db: Executor,
  principal: Principal,
  env: Env,
): Promise<SiteOverview> {
  const node = await requireNode(db, SITE_SETTINGS_PATH, env);
  await authorizeOrAudit(db, principal, 'read', nodeTarget(node), env, 'content.read');
  const latest = await latestVersion(db, node.id, env);
  return {
    settings: {
      value: (latest?.body as SiteSettings | undefined) ?? null,
      version: latest?.version ?? null,
      status: await pageStatus(db, node, env),
    },
    layouts: await sharedEntries(db, principal, env, LAYOUTS_PATH),
    menus: await sharedEntries(db, principal, env, MENUS_PATH),
  };
}

/**
 * Saves the site settings and publishes them at once: they have no preview of their own,
 * so a draft would only hide the change. `onPublished` runs after the commit.
 */
export async function saveSiteSettings(
  db: Executor,
  principal: Principal,
  env: Env,
  settings: unknown,
  options: SaveOptions & { onPublished?: PublishHook } = {},
): Promise<{ version: number; hookError?: string }> {
  const { onPublished, ...saveOptions } = options;
  const version = await db.transaction(async (tx) => {
    const node = await requireNode(tx, SITE_SETTINGS_PATH, env, { forUpdate: true });
    await authorizeOrAudit(db, principal, 'write', nodeTarget(node), env, 'content.write');
    await authorizeOrAudit(db, principal, 'publish', nodeTarget(node), env, 'content.publish');
    const saved = await insertVersion(
      tx,
      principal,
      env,
      node,
      settings,
      saveOptions,
      'content.write',
    );
    await publishVersion(tx, principal, env, node, { versionId: saved.id });
    return saved.version;
  });
  if (!onPublished) return { version };
  try {
    await onPublished([`/${SITE_SETTINGS_PATH.replaceAll('.', '/')}`], env);
    return { version };
  } catch (error) {
    return { version, hookError: error instanceof Error ? error.message : String(error) };
  }
}
