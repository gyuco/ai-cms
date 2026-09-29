import { writeAudit, type Executor } from '@ai-cms/audit';
import type { Env } from '@ai-cms/authz';
import { schema, type Database } from '@ai-cms/db';
import {
  joinLtree,
  lookupNode,
  parsePath,
  toPublicPath,
  toTreeNode,
  type TreeNode,
} from '@ai-cms/tree';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { GitError, runGit } from './git.ts';
import { parseManifest, resolveTreePathForFile, type Manifest } from './manifest.ts';
import { bareRepoPath, resolveRef, siteRepoPaths, type SiteRepoPaths } from './site-repo.ts';

const { nodes } = schema;

const REF_BY_ENV: Record<Env, string> = {
  staging: 'refs/heads/staging',
  prod: 'refs/heads/main',
};

const OTHER_ENV: Record<Env, Env> = { staging: 'prod', prod: 'staging' };

/**
 * Looks up a live git node by path regardless of its `env`: unlike `lookupNode`, which only
 * sees nodes visible in the given env, sync must find a node created for the *other* env too,
 * to promote or demote it instead of colliding with it on insert.
 */
async function findLiveNode(tx: Executor, ltreePath: string): Promise<TreeNode | null> {
  const [row] = await tx
    .select()
    .from(nodes)
    .where(and(sql`${nodes.path} = ${ltreePath}::ltree`, isNull(nodes.deletedAt)))
    .for('update');
  return row ? toTreeNode(row) : null;
}

/** Reads `cms.manifest.json` at `ref`; a missing or absent manifest means nothing to sync. */
export async function loadManifest(bareRepo: string, ref: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = await runGit(['show', `${ref}:cms.manifest.json`], { cwd: bareRepo });
  } catch (error) {
    if (error instanceof GitError) return { version: 1, rules: [], files: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`cms.manifest.json in ${ref} non è JSON valido.`);
  }
  return parseManifest(parsed);
}

/** All files committed at `ref`. */
export async function listRepoFiles(bareRepo: string, ref: string): Promise<string[]> {
  const out = await runGit(['ls-tree', '-r', '--name-only', '-z', ref], { cwd: bareRepo });
  return out.split('\0').filter(Boolean);
}

export type CodeNodeSyncStatus =
  | 'created'
  | 'promoted'
  | 'unchanged'
  | 'skipped-ancestor-missing'
  | 'skipped-invalid-name'
  | 'skipped-conflict';

export interface CodeNodeSyncOutcome {
  file: string;
  path: string;
  status: CodeNodeSyncStatus;
  detail?: string;
}

export interface CodeNodeSyncResult {
  env: Env;
  ref: string;
  /** Empty when the branch does not exist yet (site.git not initialized for this env). */
  commit: string;
  outcomes: CodeNodeSyncOutcome[];
  /** Public paths soft-deleted because their file is gone from this env. */
  deleted: string[];
  /** Public paths still present in the other env, demoted from `both` to it. */
  demoted: string[];
}

interface ReconcileResult {
  status: CodeNodeSyncStatus;
  detail?: string;
  /** The canonical public path (as `TreeNode.path` would render it), once resolved. */
  path?: string;
  ltreePath?: string;
}

async function reconcileFile(
  tx: Executor,
  env: Env,
  actorUid: number,
  match: { path: string; requiredAncestor: string },
): Promise<ReconcileResult> {
  let ancestorLtree: string;
  let targetLtree: string;
  try {
    ancestorLtree = parsePath(match.requiredAncestor);
    targetLtree = parsePath(match.path);
  } catch {
    return { status: 'skipped-invalid-name' };
  }
  const canonicalPath = toPublicPath(targetLtree);
  if (targetLtree !== ancestorLtree && !targetLtree.startsWith(`${ancestorLtree}.`)) {
    return { status: 'skipped-invalid-name', path: canonicalPath };
  }

  const ancestor = await lookupNode(tx, ancestorLtree, env, { forUpdate: true });
  if (!ancestor) {
    return {
      status: 'skipped-ancestor-missing',
      detail: match.requiredAncestor,
      path: canonicalPath,
    };
  }
  if (ancestor.kind === 'file') {
    return {
      status: 'skipped-conflict',
      detail: `${match.requiredAncestor} è un file: non può contenere altri nodi`,
      path: canonicalPath,
    };
  }

  const remainder =
    targetLtree === ancestorLtree
      ? ''
      : targetLtree.slice(ancestorLtree === '' ? 0 : ancestorLtree.length + 1);
  const segments = remainder ? remainder.split('.') : [];
  let parent: TreeNode = ancestor;
  let created = false;
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i]!;
    const isLeaf = i === segments.length - 1;
    const childLtree = joinLtree(parent.ltreePath, name);
    const existing = await findLiveNode(tx, childLtree);
    if (!existing) {
      const [row] = await tx
        .insert(nodes)
        .values({
          parentId: parent.id,
          name,
          path: childLtree,
          kind: isLeaf ? 'file' : 'dir',
          storage: 'git',
          env: isLeaf ? env : 'both',
          createdBy: actorUid,
        })
        .returning();
      parent = toTreeNode(row!);
      if (isLeaf) created = true;
      continue;
    }
    if (
      existing.storage !== 'git' ||
      (isLeaf ? existing.kind !== 'file' : existing.kind === 'file')
    ) {
      return {
        status: 'skipped-conflict',
        detail: `${existing.path} esiste già con un tipo incompatibile`,
        path: canonicalPath,
      };
    }
    if (isLeaf && existing.env !== 'both' && existing.env !== env) {
      await tx
        .update(nodes)
        .set({ env: 'both', version: sql`${nodes.version} + 1`, updatedAt: new Date() })
        .where(eq(nodes.id, existing.id));
      return { status: 'promoted', ltreePath: targetLtree, path: canonicalPath };
    }
    parent = existing;
  }
  return {
    status: created ? 'created' : 'unchanged',
    ltreePath: targetLtree,
    path: canonicalPath,
  };
}

/** Soft-deletes or demotes git file nodes not touched by this run's `seen` set. */
async function sweep(
  tx: Executor,
  env: Env,
  seen: ReadonlySet<string>,
): Promise<{ deleted: string[]; demoted: string[] }> {
  const rows = await tx
    .select()
    .from(nodes)
    .where(and(eq(nodes.storage, 'git'), eq(nodes.kind, 'file'), isNull(nodes.deletedAt)));
  const deleted: string[] = [];
  const demoted: string[] = [];
  for (const row of rows) {
    const node = toTreeNode(row);
    if (seen.has(node.ltreePath)) continue;
    if (node.env !== 'both' && node.env !== env) continue;
    if (node.env === 'both') {
      await tx
        .update(nodes)
        .set({ env: OTHER_ENV[env], version: sql`${nodes.version} + 1`, updatedAt: new Date() })
        .where(eq(nodes.id, node.id));
      demoted.push(node.path);
    } else {
      await tx
        .update(nodes)
        .set({ deletedAt: new Date(), version: sql`${nodes.version} + 1`, updatedAt: new Date() })
        .where(eq(nodes.id, node.id));
      deleted.push(node.path);
    }
  }
  return { deleted, demoted };
}

export interface SyncCodeNodesOptions {
  paths?: SiteRepoPaths;
  actorUid: number;
}

/**
 * Reconciles nodes with `storage='git'` against the files actually committed for `env`
 * (`main` for prod, `staging` for staging), per `cms.manifest.json` (E10.2). Best-effort: a
 * file whose ancestor (e.g. its page) does not exist yet is skipped, not fatal.
 */
export async function syncCodeNodes(
  db: Database,
  env: Env,
  options: SyncCodeNodesOptions,
): Promise<CodeNodeSyncResult> {
  const paths = options.paths ?? siteRepoPaths();
  const bare = bareRepoPath(paths.gitRoot);
  const ref = REF_BY_ENV[env];
  const commit = await resolveRef(bare, ref);
  if (!commit) return { env, ref, commit: '', outcomes: [], deleted: [], demoted: [] };

  const manifest = await loadManifest(bare, ref);
  const files = await listRepoFiles(bare, ref);

  return db.transaction(async (tx) => {
    const outcomes: CodeNodeSyncOutcome[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const match = resolveTreePathForFile(manifest, file);
      if (!match) continue;
      const result = await reconcileFile(tx, env, options.actorUid, match);
      outcomes.push({
        file,
        path: result.path ?? match.path,
        status: result.status,
        detail: result.detail,
      });
      if (result.ltreePath) seen.add(result.ltreePath);
    }
    const { deleted, demoted } = await sweep(tx, env, seen);
    await writeAudit(tx, {
      actorUid: options.actorUid,
      action: 'tree.git-sync',
      env,
      outcome: 'ok',
      details: {
        ref,
        commit,
        files: files.length,
        matched: outcomes.length,
        deleted: deleted.length,
        demoted: demoted.length,
      },
    });
    return { env, ref, commit, outcomes, deleted, demoted };
  });
}
