import type { Env, Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import {
  NotFoundError,
  ValidationError,
  assertNodeName,
  authorizeOrAudit,
  createNode,
  joinLtree,
  lookupNode,
  nodeTarget,
  requireNode,
  type Executor,
  type TreeNode,
} from '@ai-cms/tree';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  formatIssues,
  parseLayout,
  parseMenu,
  parseSiteSettings,
  type Layout,
  type Menu,
  type ParseResult,
  type SiteSettings,
} from '../documents.ts';

const { contentVersions, nodes, publications } = schema;

export const SITE_SETTINGS_PATH = 'site.settings';
export const LAYOUTS_PATH = 'site.layouts';
export const MENUS_PATH = 'site.menus';
/** Layouts every site has (FR-23). */
export const DEFAULT_LAYOUTS = ['header', 'footer'] as const;
export const DEFAULT_MENU = 'main';

/** Published body of a live node in `env`, or null. No authorization. */
async function publishedBody(db: Executor, node: TreeNode, env: Env): Promise<unknown> {
  const [row] = await db
    .select({ body: contentVersions.body })
    .from(publications)
    .innerJoin(contentVersions, eq(contentVersions.id, publications.versionId))
    .where(
      and(
        eq(publications.nodeId, node.id),
        eq(publications.env, env),
        eq(publications.status, 'published'),
      ),
    );
  return row ? row.body : null;
}

function parsed<T>(node: TreeNode, result: ParseResult<T>): T {
  if (result.ok) return result.value;
  throw new ValidationError(
    `Il contenuto pubblicato di ${node.path} non è valido:\n${formatIssues(result.errors)}`,
  );
}

/** Published site settings (name, title template, language, favicon). */
export async function getSiteSettings(
  db: Executor,
  principal: Principal,
  env: Env,
): Promise<SiteSettings> {
  const node = await requireNode(db, SITE_SETTINGS_PATH, env);
  await authorizeOrAudit(db, principal, 'read', nodeTarget(node), env, 'content.read');
  const body = await publishedBody(db, node, env);
  if (body === null) {
    throw new NotFoundError(`Le impostazioni del sito non sono pubblicate in ${env}.`, node.path);
  }
  return parsed(node, parseSiteSettings(body));
}

export interface SharedReadOptions {
  /** Create the node (via `createNode`) when it does not exist yet. */
  createIfMissing?: boolean;
}

async function sharedNode(
  db: Executor,
  principal: Principal,
  env: Env,
  parentPath: string,
  name: string,
  kind: 'layout' | 'menu',
  create: boolean,
): Promise<TreeNode | null> {
  assertNodeName(name);
  const existing = await lookupNode(db, joinLtree(parentPath, name), env);
  if (existing) {
    if (existing.kind !== kind) {
      throw new ValidationError(`${existing.path} non è di tipo "${kind}".`);
    }
    return existing;
  }
  if (!create) return null;
  return createNode(db, principal, env, parentPath, { name, kind });
}

/** Creates `/site/layouts/<name>` if missing and returns it. */
export async function ensureLayout(
  db: Executor,
  principal: Principal,
  env: Env,
  name: string,
): Promise<TreeNode> {
  return (await sharedNode(db, principal, env, LAYOUTS_PATH, name, 'layout', true))!;
}

/** Creates `/site/menus/<name>` if missing and returns it. */
export async function ensureMenu(
  db: Executor,
  principal: Principal,
  env: Env,
  name: string,
): Promise<TreeNode> {
  return (await sharedNode(db, principal, env, MENUS_PATH, name, 'menu', true))!;
}

/** Creates the default header and footer layouts and the main menu when missing. */
export async function ensureSharedNodes(
  db: Executor,
  principal: Principal,
  env: Env,
): Promise<TreeNode[]> {
  const created: TreeNode[] = [];
  for (const name of DEFAULT_LAYOUTS) created.push(await ensureLayout(db, principal, env, name));
  created.push(await ensureMenu(db, principal, env, DEFAULT_MENU));
  return created;
}

/** Published layout (e.g. `header`, `footer`), or null when missing or not published. */
export async function getLayout(
  db: Executor,
  principal: Principal,
  env: Env,
  name: string,
  options: SharedReadOptions = {},
): Promise<Layout | null> {
  const node = await sharedNode(
    db,
    principal,
    env,
    LAYOUTS_PATH,
    name,
    'layout',
    options.createIfMissing ?? false,
  );
  if (!node) return null;
  await authorizeOrAudit(db, principal, 'read', nodeTarget(node), env, 'content.read');
  const body = await publishedBody(db, node, env);
  return body === null ? null : parsed(node, parseLayout(body));
}

/** Published menu (e.g. `main`), or null when missing or not published. */
export async function getMenu(
  db: Executor,
  principal: Principal,
  env: Env,
  name: string,
  options: SharedReadOptions = {},
): Promise<Menu | null> {
  const node = await sharedNode(
    db,
    principal,
    env,
    MENUS_PATH,
    name,
    'menu',
    options.createIfMissing ?? false,
  );
  if (!node) return null;
  await authorizeOrAudit(db, principal, 'read', nodeTarget(node), env, 'content.read');
  const body = await publishedBody(db, node, env);
  return body === null ? null : parsed(node, parseMenu(body));
}

export interface SharedElements {
  settings: SiteSettings | null;
  layouts: Record<string, Layout>;
  menus: Record<string, Menu>;
}

/**
 * Everything the site renderer needs around a page, in one query: published settings,
 * layouts and menus. Invalid published bodies are skipped rather than breaking the page.
 */
export async function getSharedElements(
  db: Executor,
  principal: Principal,
  env: Env,
): Promise<SharedElements> {
  const site = await requireNode(db, 'site', env);
  await authorizeOrAudit(db, principal, 'read', nodeTarget(site), env, 'content.read');
  const rows = await db
    .select({ path: nodes.path, kind: nodes.kind, name: nodes.name, body: contentVersions.body })
    .from(publications)
    .innerJoin(nodes, eq(nodes.id, publications.nodeId))
    .innerJoin(contentVersions, eq(contentVersions.id, publications.versionId))
    .where(
      and(
        eq(publications.env, env),
        eq(publications.status, 'published'),
        isNull(nodes.deletedAt),
        sql`(${nodes.path} = ${SITE_SETTINGS_PATH}::ltree
          OR (${nodes.path} ~ ${`${LAYOUTS_PATH}.*{1}`}::lquery AND ${nodes.kind} = 'layout')
          OR (${nodes.path} ~ ${`${MENUS_PATH}.*{1}`}::lquery AND ${nodes.kind} = 'menu'))`,
      ),
    );
  const result: SharedElements = { settings: null, layouts: {}, menus: {} };
  for (const row of rows) {
    if (row.path === SITE_SETTINGS_PATH) {
      const settings = parseSiteSettings(row.body);
      if (settings.ok) result.settings = settings.value;
    } else if (row.kind === 'layout') {
      const layout = parseLayout(row.body);
      if (layout.ok) result.layouts[row.name] = layout.value;
    } else {
      const menu = parseMenu(row.body);
      if (menu.ok) result.menus[row.name] = menu.value;
    }
  }
  return result;
}
