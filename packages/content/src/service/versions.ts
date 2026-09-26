import type { Env, Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  auditOk,
  authorizeOrAudit,
  nodeTarget,
  parsePath,
  requireNode,
  type Executor,
  type TreeNode,
} from '@ai-cms/tree';
import { and, desc, eq, sql } from 'drizzle-orm';
import { diffBodies, type BodyDiff } from '../diff.ts';
import { formatIssues } from '../documents.ts';
import { normalizeBodyForKind } from '../kinds.ts';

const { contentVersions, publications } = schema;

export interface ContentVersion {
  id: number;
  nodeId: string;
  env: Env;
  version: number;
  body: unknown;
  authorUid: number;
  viaAgent: string | null;
  conversationId: string | null;
  createdAt: Date;
}

export type VersionInfo = Omit<ContentVersion, 'body'> & { published: boolean };

export interface ContentSnapshot extends ContentVersion {
  node: TreeNode;
  /** True when this is the version currently published in `env`. */
  published: boolean;
}

/** A version number, the last saved version or the one currently published. */
export type VersionRef = number | 'latest' | 'published';

export interface SaveOptions {
  /** Number of the last content version the caller saw (0 if none); a mismatch conflicts. */
  expectedVersion?: number;
  /** Defaults to the principal's agent name. */
  viaAgent?: string | null;
  conversationId?: string | null;
}

export type PublishHook = (paths: string[], env: Env) => Promise<void>;

const toVersion = (row: typeof contentVersions.$inferSelect): ContentVersion => ({
  id: row.id,
  nodeId: row.nodeId,
  env: row.env,
  version: row.version,
  body: row.body,
  authorUid: row.authorUid,
  viaAgent: row.viaAgent,
  conversationId: row.conversationId,
  createdAt: row.createdAt,
});

/** Latest saved version of a node in `env`, without authorization. */
export async function latestVersion(
  db: Executor,
  nodeId: string,
  env: Env,
): Promise<ContentVersion | null> {
  const [row] = await db
    .select()
    .from(contentVersions)
    .where(and(eq(contentVersions.nodeId, nodeId), eq(contentVersions.env, env)))
    .orderBy(desc(contentVersions.version))
    .limit(1);
  return row ? toVersion(row) : null;
}

/** The published version id of a node in `env`, or null. */
export async function publishedVersionId(
  db: Executor,
  nodeId: string,
  env: Env,
): Promise<number | null> {
  const [row] = await db
    .select({ versionId: publications.versionId })
    .from(publications)
    .where(
      and(
        eq(publications.nodeId, nodeId),
        eq(publications.env, env),
        eq(publications.status, 'published'),
      ),
    );
  return row?.versionId ?? null;
}

/** Resolves a version reference, without authorization. Throws `NotFoundError`. */
export async function resolveVersion(
  db: Executor,
  node: TreeNode,
  env: Env,
  ref: VersionRef,
): Promise<ContentVersion> {
  let row: typeof contentVersions.$inferSelect | undefined;
  if (ref === 'latest') {
    const latest = await latestVersion(db, node.id, env);
    if (!latest)
      throw new NotFoundError(`${node.path} non ha ancora contenuti in ${env}.`, node.path);
    return latest;
  }
  if (ref === 'published') {
    const versionId = await publishedVersionId(db, node.id, env);
    if (versionId === null) {
      throw new NotFoundError(`${node.path} non è pubblicato in ${env}.`, node.path);
    }
    [row] = await db.select().from(contentVersions).where(eq(contentVersions.id, versionId));
  } else {
    [row] = await db
      .select()
      .from(contentVersions)
      .where(
        and(
          eq(contentVersions.nodeId, node.id),
          eq(contentVersions.env, env),
          eq(contentVersions.version, ref),
        ),
      );
  }
  if (!row) {
    throw new NotFoundError(`${node.path} non ha una versione ${ref} in ${env}.`, node.path);
  }
  return toVersion(row);
}

/** Validates the body against the node kind; throws `ValidationError` with readable issues. */
export function normalizeForNode(node: TreeNode, body: unknown): unknown {
  if (node.storage === 'git' || node.storage === 'virtual') {
    throw new ValidationError(
      `${node.path} non è un contenuto modificabile qui (archiviazione "${node.storage}").`,
    );
  }
  const result = normalizeBodyForKind(node.kind, body);
  if (!result.ok) {
    const issues = result.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message));
    throw new ValidationError(
      `Contenuto non valido per ${node.path}:\n${formatIssues(result.errors)}`,
      issues,
    );
  }
  return result.value;
}

/**
 * Inserts a new version for an already locked and authorized node. Callers hold the
 * node row lock (`requireNode(..., { forUpdate: true })`) so numbering is serialized.
 */
export async function insertVersion(
  tx: Executor,
  principal: Principal,
  env: Env,
  node: TreeNode,
  body: unknown,
  options: SaveOptions,
  auditAction: string,
  auditDetails: Record<string, unknown> = {},
): Promise<ContentVersion> {
  const normalized = normalizeForNode(node, body);
  const latest = await latestVersion(tx, node.id, env);
  const current = latest?.version ?? 0;
  if (options.expectedVersion !== undefined && options.expectedVersion !== current) {
    throw new ConflictError({
      path: node.path,
      expectedVersion: options.expectedVersion,
      currentVersion: current,
    });
  }
  const [row] = await tx
    .insert(contentVersions)
    .values({
      nodeId: node.id,
      env,
      version: current + 1,
      body: normalized,
      authorUid: principal.uid,
      viaAgent: options.viaAgent === undefined ? (principal.agent?.name ?? null) : options.viaAgent,
      conversationId: options.conversationId ?? null,
    })
    .returning();
  await auditOk(tx, principal, env, auditAction, node.ltreePath, {
    nodeId: node.id,
    version: row!.version,
    versionId: row!.id,
    conversationId: row!.conversationId,
    ...auditDetails,
  });
  return toVersion(row!);
}

/** Saves a new version (FR-60). The body is validated and normalized for the node kind. */
export async function saveDraft(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  body: unknown,
  options: SaveOptions = {},
): Promise<ContentVersion> {
  const ltreePath = parsePath(path);
  return db.transaction(async (tx) => {
    const node = await requireNode(tx, ltreePath, env, { forUpdate: true });
    await authorizeOrAudit(db, principal, 'write', nodeTarget(node), env, 'content.write');
    return insertVersion(tx, principal, env, node, body, options, 'content.write');
  });
}

export async function getContent(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  options: { version?: VersionRef } = {},
): Promise<ContentSnapshot> {
  const node = await requireNode(db, parsePath(path), env);
  await authorizeOrAudit(db, principal, 'read', nodeTarget(node), env, 'content.read');
  const version = await resolveVersion(db, node, env, options.version ?? 'latest');
  const publishedId = await publishedVersionId(db, node.id, env);
  return { ...version, node, published: publishedId === version.id };
}

/** All versions of a node in `env`, newest first, without bodies. */
export async function listVersions(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
): Promise<VersionInfo[]> {
  const node = await requireNode(db, parsePath(path), env);
  await authorizeOrAudit(db, principal, 'read', nodeTarget(node), env, 'content.read');
  const publishedId = await publishedVersionId(db, node.id, env);
  const rows = await db
    .select({
      id: contentVersions.id,
      nodeId: contentVersions.nodeId,
      env: contentVersions.env,
      version: contentVersions.version,
      authorUid: contentVersions.authorUid,
      viaAgent: contentVersions.viaAgent,
      conversationId: contentVersions.conversationId,
      createdAt: contentVersions.createdAt,
    })
    .from(contentVersions)
    .where(and(eq(contentVersions.nodeId, node.id), eq(contentVersions.env, env)))
    .orderBy(desc(contentVersions.version));
  return rows.map((row) => ({ ...row, published: row.id === publishedId }));
}

export interface VersionDiff {
  from: number;
  to: number;
  diff: BodyDiff;
}

/** Compares two versions of the same node (FR-61). */
export async function diffVersions(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  from: VersionRef,
  to: VersionRef,
): Promise<VersionDiff> {
  const node = await requireNode(db, parsePath(path), env);
  await authorizeOrAudit(db, principal, 'read', nodeTarget(node), env, 'content.read');
  const a = await resolveVersion(db, node, env, from);
  const b = await resolveVersion(db, node, env, to);
  return { from: a.version, to: b.version, diff: diffBodies(a.body, b.body) };
}

/** Creates a new version equal to an earlier one (FR-62). */
export async function restoreVersion(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  version: number,
  options: SaveOptions = {},
): Promise<ContentVersion> {
  const ltreePath = parsePath(path);
  return db.transaction(async (tx) => {
    const node = await requireNode(tx, ltreePath, env, { forUpdate: true });
    await authorizeOrAudit(db, principal, 'write', nodeTarget(node), env, 'content.restore');
    const source = await resolveVersion(tx, node, env, version);
    return insertVersion(tx, principal, env, node, source.body, options, 'content.restore', {
      restoredFrom: source.version,
    });
  });
}

export interface PublishOptions {
  /** `content_versions.id` to publish. */
  versionId?: number;
  /** Version number to publish; ignored when `versionId` is given. Default: the latest. */
  version?: number;
  /**
   * Called after the transaction commits, e.g. to revalidate the site. When `db` is an outer
   * transaction, call the hook yourself after that transaction commits instead.
   */
  onPublished?: PublishHook;
}

export interface PublishResult {
  path: string;
  env: Env;
  status: 'published' | 'archived';
  version: number | null;
  versionId: number | null;
  /** Set when the `onPublished` hook failed: the publication itself stays committed. */
  hookError?: string;
}

async function runHook(
  hook: PublishHook | undefined,
  paths: string[],
  env: Env,
): Promise<string | undefined> {
  if (!hook) return undefined;
  try {
    await hook(paths, env);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Publishes a version, by default the latest (TECHNICAL §9). */
export async function publish(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const ltreePath = parsePath(path);
  const result = await db.transaction(async (tx) => {
    const node = await requireNode(tx, ltreePath, env, { forUpdate: true });
    await authorizeOrAudit(db, principal, 'publish', nodeTarget(node), env, 'content.publish');
    return publishVersion(tx, principal, env, node, options);
  });
  const hookError = await runHook(options.onPublished, [result.path], env);
  return hookError ? { ...result, hookError } : result;
}

/** Publishes on an already locked and authorized node. */
export async function publishVersion(
  tx: Executor,
  principal: Principal,
  env: Env,
  node: TreeNode,
  options: Pick<PublishOptions, 'version' | 'versionId'> = {},
): Promise<PublishResult> {
  let version: ContentVersion;
  if (options.versionId !== undefined) {
    const [row] = await tx
      .select()
      .from(contentVersions)
      .where(
        and(
          eq(contentVersions.id, options.versionId),
          eq(contentVersions.nodeId, node.id),
          eq(contentVersions.env, env),
        ),
      );
    if (!row) {
      throw new NotFoundError(
        `La versione ${options.versionId} non appartiene a ${node.path} in ${env}.`,
        node.path,
      );
    }
    version = toVersion(row);
  } else {
    version = await resolveVersion(tx, node, env, options.version ?? 'latest');
  }
  const previous = await publishedVersionId(tx, node.id, env);
  const values = {
    versionId: version.id,
    status: 'published' as const,
    publishAt: null,
    publishedBy: principal.uid,
    publishedAt: sql`now()`,
  };
  await tx
    .insert(publications)
    .values({ nodeId: node.id, env, ...values })
    .onConflictDoUpdate({ target: [publications.nodeId, publications.env], set: values });
  await auditOk(tx, principal, env, 'content.publish', node.ltreePath, {
    nodeId: node.id,
    version: version.version,
    versionId: version.id,
    previousVersionId: previous,
  });
  return {
    path: node.path,
    env,
    status: 'published',
    version: version.version,
    versionId: version.id,
  };
}

/** Withdraws a node from the site (status `archived`). A no-op if it is not published. */
export async function unpublish(
  db: Executor,
  principal: Principal,
  env: Env,
  path: string,
  options: Pick<PublishOptions, 'onPublished'> = {},
): Promise<PublishResult> {
  const ltreePath = parsePath(path);
  const result = await db.transaction(async (tx) => {
    const node = await requireNode(tx, ltreePath, env, { forUpdate: true });
    await authorizeOrAudit(db, principal, 'publish', nodeTarget(node), env, 'content.unpublish');
    return unpublishNode(tx, principal, env, node);
  });
  const hookError = await runHook(options.onPublished, [result.path], env);
  return hookError ? { ...result, hookError } : result;
}

/** Unpublishes an already locked and authorized node. */
export async function unpublishNode(
  tx: Executor,
  principal: Principal,
  env: Env,
  node: TreeNode,
): Promise<PublishResult> {
  const [updated] = await tx
    .update(publications)
    .set({ status: 'archived', publishedBy: principal.uid, publishedAt: sql`now()` })
    .where(
      and(
        eq(publications.nodeId, node.id),
        eq(publications.env, env),
        eq(publications.status, 'published'),
      ),
    )
    .returning({ versionId: publications.versionId });
  if (updated) {
    await auditOk(tx, principal, env, 'content.unpublish', node.ltreePath, {
      nodeId: node.id,
      versionId: updated.versionId,
    });
  }
  return {
    path: node.path,
    env,
    status: 'archived',
    version: null,
    versionId: updated?.versionId ?? null,
  };
}
