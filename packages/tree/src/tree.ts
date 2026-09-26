import type { Executor } from '@ai-cms/audit';
import type { Env, NodeTarget, Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import { and, asc, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError, isUniqueViolation } from './errors.ts';
import { auditOk, authorizeOrAudit } from './guard.ts';
import { assertNodeName, joinLtree, parentLtree, parsePath, toPublicPath } from './paths.ts';

const { nodes, nodeKinds, nodeStorages, nodeEnvs } = schema;

export type NodeKind = schema.NodeKind;
export type NodeStorage = schema.NodeStorage;
export type NodeEnv = schema.NodeEnv;

export interface TreeNode {
  id: string;
  parentId: string | null;
  name: string;
  /** Public form, e.g. `/site/pages/blog`. */
  path: string;
  /** ltree form, e.g. `site.pages.blog`. */
  ltreePath: string;
  kind: NodeKind;
  storage: NodeStorage;
  env: NodeEnv;
  version: number;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

type NodeRow = typeof nodes.$inferSelect;

export function toTreeNode(row: NodeRow): TreeNode {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    path: toPublicPath(row.path),
    ltreePath: row.path,
    kind: row.kind,
    storage: row.storage,
    env: row.env,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** What authz needs to know about a node. */
export function nodeTarget(node: Pick<TreeNode, 'ltreePath' | 'kind' | 'storage'>): NodeTarget {
  return { path: node.ltreePath, kind: node.kind, storage: node.storage };
}

/** Kinds that cannot contain other nodes. */
const LEAF_KINDS: ReadonlySet<NodeKind> = new Set([
  'asset',
  'file',
  'setting',
  'secret',
  'layout',
  'menu',
]);

/** The base structure (seed): it can be edited, not deleted, moved or renamed. */
const PROTECTED_PATHS: ReadonlySet<string> = new Set([
  '',
  'site',
  'site.pages',
  'site.pages.index',
  'site.layouts',
  'site.components',
  'site.menus',
  'site.assets',
  'site.settings',
  'data',
  'data.collections',
  'code',
  'code.api',
  'code.lib',
  'code.migrations',
  'releases',
  'system',
  'system.users',
  'system.agents',
  'system.ai',
  'system.secrets',
  'system.audit',
]);

export function isProtectedPath(ltreePath: string): boolean {
  return PROTECTED_PATHS.has(ltreePath);
}

const visibleIn = (env: Env) => or(eq(nodes.env, env), eq(nodes.env, 'both'));

/**
 * Loads a live node visible in `env`, without authorization. Only for services that
 * authorize the action themselves (content, plans); everyone else uses `getNode`.
 */
export async function lookupNode(
  db: Executor,
  ltreePath: string,
  env: Env,
  options: { forUpdate?: boolean } = {},
): Promise<TreeNode | null> {
  const query = db
    .select()
    .from(nodes)
    .where(and(sql`${nodes.path} = ${ltreePath}::ltree`, isNull(nodes.deletedAt), visibleIn(env)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row ? toTreeNode(row) : null;
}

/** Like `lookupNode`, but throws `NotFoundError`. */
export async function requireNode(
  db: Executor,
  ltreePath: string,
  env: Env,
  options: { forUpdate?: boolean } = {},
): Promise<TreeNode> {
  const node = await lookupNode(db, ltreePath, env, options);
  if (!node) {
    const path = toPublicPath(ltreePath);
    throw new NotFoundError(`Il nodo ${path} non esiste.`, path);
  }
  return node;
}

function checkVersion(node: TreeNode, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && node.version !== expectedVersion) {
    throw new ConflictError({
      path: node.path,
      expectedVersion,
      currentVersion: node.version,
    });
  }
}

function assertNotProtected(node: TreeNode, verb: string): void {
  if (isProtectedPath(node.ltreePath)) {
    throw new ValidationError(
      `${node.path} fa parte della struttura di base del sito e non si può ${verb}.`,
    );
  }
}

function assertCanContain(parent: TreeNode): void {
  if (LEAF_KINDS.has(parent.kind)) {
    throw new ValidationError(
      `${parent.path} (tipo "${parent.kind}") non può contenere altri nodi.`,
    );
  }
}

function assertEnvCompatible(parent: TreeNode, childEnv: NodeEnv, env: Env): void {
  if (childEnv !== 'both' && childEnv !== env) {
    throw new ValidationError(
      `Non si può creare in ${env} un nodo riservato all'ambiente ${childEnv}.`,
    );
  }
  if (parent.env !== 'both' && childEnv !== parent.env) {
    throw new ValidationError(
      `${parent.path} esiste solo in ${parent.env}: anche i nodi al suo interno devono esserlo.`,
    );
  }
}

async function assertFree(db: Executor, ltreePath: string): Promise<void> {
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(sql`${nodes.path} = ${ltreePath}::ltree`, isNull(nodes.deletedAt)));
  if (existing) {
    throw new ValidationError(`Esiste già un nodo in ${toPublicPath(ltreePath)}.`);
  }
}

function alreadyExists(ltreePath: string): ValidationError {
  return new ValidationError(`Esiste già un nodo in ${toPublicPath(ltreePath)}.`);
}

export interface VersionOptions {
  /** The `version` the caller last saw; a mismatch throws `ConflictError`. */
  expectedVersion?: number;
}

export async function getNode(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
): Promise<TreeNode> {
  const node = await requireNode(db, parsePath(path), env);
  await authorizeOrAudit(db, principal, 'read', nodeTarget(node), env, 'node.read');
  return node;
}

export async function listChildren(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
): Promise<TreeNode[]> {
  const parent = await requireNode(db, parsePath(path), env);
  await authorizeOrAudit(db, principal, 'list', nodeTarget(parent), env, 'node.list');
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.parentId, parent.id), isNull(nodes.deletedAt), visibleIn(env)))
    .orderBy(asc(nodes.name));
  return rows.map(toTreeNode);
}

export interface CreateNodeInput {
  name: string;
  kind: NodeKind;
  /** Defaults to `git` under a git node, `db` otherwise. */
  storage?: NodeStorage;
  /** Defaults to the parent's env. */
  env?: NodeEnv;
}

export async function createNode(
  db: Executor,
  principal: Principal,
  env: Env,
  parentPath: string,
  input: CreateNodeInput,
): Promise<TreeNode> {
  const parentLtreePath = parsePath(parentPath);
  assertNodeName(input.name);
  if (!(nodeKinds as readonly string[]).includes(input.kind)) {
    throw new ValidationError(`Tipo di nodo sconosciuto: "${input.kind}".`);
  }
  if (input.storage !== undefined && !(nodeStorages as readonly string[]).includes(input.storage)) {
    throw new ValidationError(`Archiviazione sconosciuta: "${input.storage}".`);
  }
  if (input.env !== undefined && !(nodeEnvs as readonly string[]).includes(input.env)) {
    throw new ValidationError(`Ambiente sconosciuto: "${input.env}".`);
  }

  return db.transaction(async (tx) => {
    const parent = await requireNode(tx, parentLtreePath, env, { forUpdate: true });
    const ltreePath = joinLtree(parent.ltreePath, input.name);
    const storage = input.storage ?? (parent.storage === 'git' ? 'git' : 'db');
    const childEnv = input.env ?? parent.env;
    // The parent decides whether one may create here; the child target lets the system
    // invariants see the new node's own storage (e.g. a git node in prod).
    await authorizeOrAudit(db, principal, 'create', nodeTarget(parent), env, 'node.create');
    await authorizeOrAudit(
      db,
      principal,
      'create',
      { path: ltreePath, kind: input.kind, storage },
      env,
      'node.create',
    );
    assertCanContain(parent);
    assertEnvCompatible(parent, childEnv, env);
    await assertFree(tx, ltreePath);

    let row: NodeRow | undefined;
    try {
      [row] = await tx
        .insert(nodes)
        .values({
          parentId: parent.id,
          name: input.name,
          path: ltreePath,
          kind: input.kind,
          storage,
          env: childEnv,
          createdBy: principal.uid,
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error)) throw alreadyExists(ltreePath);
      throw error;
    }
    await auditOk(tx, principal, env, 'node.create', ltreePath, {
      id: row!.id,
      kind: input.kind,
      storage,
      nodeEnv: childEnv,
    });
    return toTreeNode(row!);
  });
}

/** Rewrites the paths of `node` and all its descendants (deleted ones too) under a new prefix. */
async function relocate(
  tx: Executor,
  node: TreeNode,
  newParent: TreeNode,
  newName: string,
): Promise<string> {
  const oldPath = node.ltreePath;
  const newPath = joinLtree(newParent.ltreePath, newName);
  try {
    // Descendants are found through parent_id rather than `path <@ old`: an older deleted
    // node may share the path without being part of this subtree.
    await tx.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM nodes WHERE id = ${node.id}
        UNION ALL
        SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
      )
      UPDATE nodes SET
        path = CASE
          WHEN nodes.id = ${node.id} THEN ${newPath}::ltree
          ELSE ${newPath}::ltree || subpath(nodes.path, nlevel(${oldPath}::ltree))
        END,
        version = nodes.version + 1,
        updated_at = now()
      WHERE nodes.id IN (SELECT id FROM subtree)
    `);
  } catch (error) {
    if (isUniqueViolation(error)) throw alreadyExists(newPath);
    throw error;
  }
  await tx
    .update(nodes)
    .set({ parentId: newParent.id, name: newName })
    .where(eq(nodes.id, node.id));
  return newPath;
}

async function reload(tx: Executor, id: string): Promise<TreeNode> {
  const [row] = await tx.select().from(nodes).where(eq(nodes.id, id));
  return toTreeNode(row!);
}

export async function renameNode(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  newName: string,
  options: VersionOptions = {},
): Promise<TreeNode> {
  const ltreePath = parsePath(path);
  assertNodeName(newName);
  return db.transaction(async (tx) => {
    const node = await requireNode(tx, ltreePath, env, { forUpdate: true });
    const parent = await requireParent(tx, node, env);
    await authorizeOrAudit(db, principal, 'delete', nodeTarget(node), env, 'node.rename');
    await authorizeOrAudit(
      db,
      principal,
      'create',
      { path: joinLtree(parent.ltreePath, newName), kind: node.kind, storage: node.storage },
      env,
      'node.rename',
    );
    checkVersion(node, options.expectedVersion);
    assertNotProtected(node, 'rinominare');
    if (newName === node.name) return node;
    await assertFree(tx, joinLtree(parent.ltreePath, newName));
    const newPath = await relocate(tx, node, parent, newName);
    await auditOk(tx, principal, env, 'node.rename', newPath, {
      id: node.id,
      from: node.ltreePath,
      to: newPath,
    });
    return reload(tx, node.id);
  });
}

async function requireParent(tx: Executor, node: TreeNode, env: Env): Promise<TreeNode> {
  const parent = await lookupNode(tx, parentLtree(node.ltreePath), env);
  if (!parent || parent.id !== node.parentId) {
    throw new NotFoundError(`Il nodo che contiene ${node.path} non esiste.`, node.path);
  }
  return parent;
}

export interface MoveOptions extends VersionOptions {
  /** New name in the destination; defaults to the current name. */
  name?: string;
}

export async function moveNode(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  newParentPath: string,
  options: MoveOptions = {},
): Promise<TreeNode> {
  const ltreePath = parsePath(path);
  const newParentLtreePath = parsePath(newParentPath);
  if (options.name !== undefined) assertNodeName(options.name);
  return db.transaction(async (tx) => {
    const node = await requireNode(tx, ltreePath, env, { forUpdate: true });
    const newParent = await requireNode(tx, newParentLtreePath, env, { forUpdate: true });
    const name = options.name ?? node.name;
    const newPath = joinLtree(newParent.ltreePath, name);
    await authorizeOrAudit(db, principal, 'delete', nodeTarget(node), env, 'node.move');
    await authorizeOrAudit(db, principal, 'create', nodeTarget(newParent), env, 'node.move');
    await authorizeOrAudit(
      db,
      principal,
      'create',
      { path: newPath, kind: node.kind, storage: node.storage },
      env,
      'node.move',
    );
    checkVersion(node, options.expectedVersion);
    assertNotProtected(node, 'spostare');
    if (newParent.id === node.parentId && name === node.name) return node;
    if (
      newParent.ltreePath === node.ltreePath ||
      newParent.ltreePath.startsWith(`${node.ltreePath}.`)
    ) {
      throw new ValidationError(`Non si può spostare ${node.path} dentro se stesso.`);
    }
    assertCanContain(newParent);
    assertEnvCompatible(newParent, node.env, env);
    await assertFree(tx, newPath);
    await relocate(tx, node, newParent, name);
    await auditOk(tx, principal, env, 'node.move', newPath, {
      id: node.id,
      from: node.ltreePath,
      to: newPath,
    });
    return reload(tx, node.id);
  });
}

export async function deleteNode(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  options: VersionOptions = {},
): Promise<TreeNode> {
  const ltreePath = parsePath(path);
  return db.transaction(async (tx) => {
    const node = await requireNode(tx, ltreePath, env, { forUpdate: true });
    await authorizeOrAudit(db, principal, 'delete', nodeTarget(node), env, 'node.delete');
    checkVersion(node, options.expectedVersion);
    assertNotProtected(node, 'eliminare');
    // One timestamp for the whole subtree: restore brings back exactly what went together.
    const deletedAt = new Date();
    const result = await tx.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM nodes WHERE id = ${node.id}
        UNION ALL
        SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id WHERE n.deleted_at IS NULL
      )
      UPDATE nodes SET deleted_at = ${deletedAt.toISOString()}::timestamptz, version = nodes.version + 1, updated_at = now()
      WHERE nodes.id IN (SELECT id FROM subtree) AND nodes.deleted_at IS NULL
    `);
    await auditOk(tx, principal, env, 'node.delete', node.ltreePath, {
      id: node.id,
      nodes: result.count,
    });
    return reload(tx, node.id);
  });
}

export interface RestoreOptions extends VersionOptions {
  /** Which deleted node to restore when several were deleted at the same path. */
  id?: string;
}

/** Brings back a soft-deleted node together with the descendants deleted with it. */
export async function restoreNode(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  options: RestoreOptions = {},
): Promise<TreeNode> {
  const ltreePath = parsePath(path);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(nodes)
      .where(
        and(
          sql`${nodes.path} = ${ltreePath}::ltree`,
          isNotNull(nodes.deletedAt),
          visibleIn(env),
          options.id ? eq(nodes.id, options.id) : undefined,
        ),
      )
      .orderBy(desc(nodes.deletedAt))
      .limit(1)
      .for('update');
    if (!row) {
      const publicPath = toPublicPath(ltreePath);
      throw new NotFoundError(`Nel cestino non c'è nessun nodo ${publicPath}.`, publicPath);
    }
    const node = toTreeNode(row);
    const parent = await lookupNode(tx, parentLtree(ltreePath), env);
    if (!parent || parent.id !== node.parentId) {
      throw new NotFoundError(
        `La cartella che conteneva ${node.path} non esiste più: ripristina prima quella.`,
        node.path,
      );
    }
    await authorizeOrAudit(db, principal, 'create', nodeTarget(parent), env, 'node.restore');
    await authorizeOrAudit(db, principal, 'create', nodeTarget(node), env, 'node.restore');
    checkVersion(node, options.expectedVersion);
    await assertFree(tx, ltreePath);
    let result;
    try {
      result = await tx.execute(sql`
        WITH RECURSIVE subtree AS (
          SELECT id FROM nodes WHERE id = ${node.id}
          UNION ALL
          SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
          WHERE n.deleted_at = ${node.deletedAt!.toISOString()}::timestamptz
        )
        UPDATE nodes SET deleted_at = NULL, version = nodes.version + 1, updated_at = now()
        WHERE nodes.id IN (SELECT id FROM subtree)
      `);
    } catch (error) {
      if (isUniqueViolation(error)) throw alreadyExists(ltreePath);
      throw error;
    }
    await auditOk(tx, principal, env, 'node.restore', ltreePath, {
      id: node.id,
      nodes: result.count,
    });
    return reload(tx, node.id);
  });
}
