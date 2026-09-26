import { AuthzError, isUnder, type Env, type NodeTarget, type Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  authorizeOrAudit,
  createNode,
  deleteNode,
  isProtectedPath,
  isValidNodeName,
  joinLtree,
  lastSegment,
  lookupNode,
  moveNode,
  parentLtree,
  parsePath,
  renameNode,
  requireNode,
  toPublicPath,
  type Executor,
  type NodeKind,
  type NodeStorage,
} from '@ai-cms/tree';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Block } from '../blocks.ts';
import { diffBodies, type BodyDiff } from '../diff.ts';
import { formatIssues, formatPath } from '../documents.ts';
import { normalizeBodyForKind } from '../kinds.ts';
import { applyBlockPatch, blockPatchOperationSchema } from '../patch.ts';
import {
  latestVersion,
  publish,
  resolveVersion,
  saveDraft,
  unpublish,
  type PublishHook,
  type SaveOptions,
} from './versions.ts';

const nonNegative = z.number().int().nonnegative();
const path = z.string().min(1).max(1024);

export const planOperationSchema = z.discriminatedUnion(
  'op',
  [
    z.strictObject({
      op: z.literal('createPage'),
      parentPath: path,
      name: z.string(),
      body: z.unknown(),
    }),
    z.strictObject({
      op: z.literal('createNode'),
      parentPath: path,
      name: z.string(),
      kind: z.enum(['dir', 'layout', 'menu']),
      body: z.unknown().optional(),
    }),
    z.strictObject({
      op: z.literal('updateBody'),
      path,
      body: z.unknown(),
      expectedVersion: nonNegative.optional(),
    }),
    z.strictObject({
      op: z.literal('patchBlocks'),
      path,
      operations: z.array(blockPatchOperationSchema).min(1).max(500),
      expectedVersion: nonNegative.optional(),
    }),
    z.strictObject({
      op: z.literal('updateMeta'),
      path,
      /** Merged into the page meta; `null` removes a key. */
      meta: z.record(z.string(), z.unknown()),
      expectedVersion: nonNegative.optional(),
    }),
    z.strictObject({
      op: z.literal('move'),
      path,
      newParentPath: path,
      name: z.string().optional(),
      expectedVersion: nonNegative.optional(),
    }),
    z.strictObject({
      op: z.literal('rename'),
      path,
      name: z.string(),
      expectedVersion: nonNegative.optional(),
    }),
    z.strictObject({ op: z.literal('delete'), path, expectedVersion: nonNegative.optional() }),
    z.strictObject({ op: z.literal('publish'), path, version: nonNegative.optional() }),
    z.strictObject({ op: z.literal('unpublish'), path }),
  ],
  { error: 'Operazione del piano sconosciuta' },
);

export const planSchema = z.array(planOperationSchema).min(1).max(200);

export type PlanOperation = z.infer<typeof planOperationSchema>;

export type PlanIssueKind = 'invalid' | 'authz' | 'not-found' | 'conflict' | 'rendering';

export interface PlanIssue {
  /** Index of the operation in the plan; -1 for the plan as a whole. */
  index: number;
  op: string;
  kind: PlanIssueKind;
  message: string;
}

/** The plan was rejected or rolled back; nothing was written (FR-63). */
export class PlanError extends ValidationError {
  readonly planIssues: PlanIssue[];
  constructor(issues: PlanIssue[], cause?: unknown) {
    const lines = issues.map((i) =>
      i.index < 0 ? `- ${i.message}` : `- operazione ${i.index + 1} (${i.op}): ${i.message}`,
    );
    super(
      `Il piano non è stato applicato, nessuna modifica è stata salvata:\n${lines.join('\n')}`,
      lines,
    );
    this.name = 'PlanError';
    this.planIssues = issues;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface PagePreview {
  /** Final public path. */
  path: string;
  kind: NodeKind;
  created: boolean;
  /** Content version before the plan, null for new content. */
  baseVersion: number | null;
  body: unknown;
  diff: BodyDiff;
}

export interface PlanResult {
  dryRun: boolean;
  /** Final public paths of every node the plan touched. */
  touched: string[];
  versions: { path: string; version: number; versionId: number }[];
  published: string[];
  unpublished: string[];
  /** Site paths whose output may have changed (published, withdrawn, moved or deleted). */
  revalidate: string[];
  /** Resulting body and diff for every node whose content changes: dry run only. */
  preview?: PagePreview[];
  /** Set when `onPublished` failed after commit; the plan itself is committed. */
  hookError?: string;
}

export type RenderValidator = (path: string, body: unknown) => Promise<{ errors: string[] }>;

export interface ExecutePlanOptions extends Pick<SaveOptions, 'conversationId' | 'viaAgent'> {
  dryRun?: boolean;
  /** Called once after commit with `revalidate`, when there is something to revalidate. */
  onPublished?: PublishHook;
  /** HTML rules on the rendered page (E6.7), checked on every publish operation. */
  validateRendered?: RenderValidator;
}

// ---------------------------------------------------------------------------------------
// Validation: every operation against the tree as it will be after the previous ones.

interface SimNode {
  kind: NodeKind;
  storage: NodeStorage;
  /** ltree path before the plan, null for nodes created by the plan. */
  original: string | null;
}

type Effect =
  | { type: 'create'; path: string; node: SimNode }
  | { type: 'delete'; path: string }
  | { type: 'move'; from: string; to: string };

const LEAF_KINDS: ReadonlySet<string> = new Set([
  'asset',
  'file',
  'setting',
  'secret',
  'layout',
  'menu',
]);

class SimulatedTree {
  private readonly effects: Effect[] = [];
  private readonly cache = new Map<string, SimNode | null>();

  constructor(
    private readonly db: Executor,
    private readonly env: Env,
  ) {}

  /** The node at `path` after the effects so far, or null. */
  async resolve(path: string): Promise<SimNode | null> {
    let current = path;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i]!;
      if (effect.type === 'create') {
        if (current === effect.path) return effect.node;
        if (isUnder(current, effect.path)) return null;
      } else if (effect.type === 'delete') {
        if (isUnder(current, effect.path)) return null;
      } else if (isUnder(current, effect.to)) {
        current = effect.from + current.slice(effect.to.length);
      } else if (isUnder(current, effect.from)) {
        return null;
      }
    }
    if (!this.cache.has(current)) {
      const node = await lookupNode(this.db, current, this.env);
      this.cache.set(
        current,
        node ? { kind: node.kind, storage: node.storage, original: node.ltreePath } : null,
      );
    }
    return this.cache.get(current)!;
  }

  apply(effect: Effect) {
    this.effects.push(effect);
  }
}

class OperationProblem extends Error {
  constructor(
    readonly kind: PlanIssueKind,
    message: string,
  ) {
    super(message);
  }
}

const invalid = (message: string) => new OperationProblem('invalid', message);

function checkName(name: string) {
  if (!isValidNodeName(name)) {
    throw invalid(
      `nome non valido "${name}": usa lettere minuscole, cifre, "-" e "_" (max 63 caratteri)`,
    );
  }
}

function checkBody(kind: string, body: unknown) {
  const result = normalizeBodyForKind(kind, body);
  if (!result.ok) throw invalid(`contenuto non valido:\n${formatIssues(result.errors)}`);
}

function describeOperation(op: PlanOperation): string {
  const where = 'path' in op ? op.path : `${op.parentPath}/${op.name}`;
  return `${op.op} ${where}`;
}

async function validatePlan(
  db: Executor,
  principal: Principal,
  env: Env,
  plan: PlanOperation[],
): Promise<PlanIssue[]> {
  const tree = new SimulatedTree(db, env);
  const issues: PlanIssue[] = [];

  const authorize = async (action: Parameters<typeof authorizeOrAudit>[2], target: NodeTarget) => {
    try {
      await authorizeOrAudit(db, principal, action, target, env, 'plan.validate');
    } catch (error) {
      if (error instanceof AuthzError) throw new OperationProblem('authz', error.message);
      throw error;
    }
  };
  const existing = async (publicPath: string) => {
    const ltree = parsePath(publicPath);
    const node = await tree.resolve(ltree);
    if (!node) throw new OperationProblem('not-found', `${toPublicPath(ltree)} non esiste`);
    return { ltree, node, target: { path: ltree, kind: node.kind, storage: node.storage } };
  };
  const free = async (ltree: string) => {
    if (await tree.resolve(ltree)) throw invalid(`esiste già un nodo in ${toPublicPath(ltree)}`);
  };
  const container = async (publicPath: string) => {
    const parent = await existing(publicPath);
    if (LEAF_KINDS.has(parent.node.kind)) {
      throw invalid(`${toPublicPath(parent.ltree)} non può contenere altri nodi`);
    }
    return parent;
  };
  const notProtected = (ltree: string, node: SimNode, verb: string) => {
    if (node.original !== null && isProtectedPath(node.original)) {
      throw invalid(`${toPublicPath(ltree)} fa parte della struttura di base e non si può ${verb}`);
    }
  };
  const relocate = async (
    source: Awaited<ReturnType<typeof existing>>,
    parentPath: string,
    name: string,
    verb: string,
  ) => {
    checkName(name);
    const parent = await container(parentPath);
    const to = joinLtree(parent.ltree, name);
    await authorize('delete', source.target);
    await authorize('create', parent.target);
    notProtected(source.ltree, source.node, verb);
    if (to === source.ltree) return;
    if (isUnder(parent.ltree, source.ltree)) {
      throw invalid(`non si può spostare ${toPublicPath(source.ltree)} dentro se stesso`);
    }
    await free(to);
    tree.apply({ type: 'move', from: source.ltree, to });
  };

  for (const [index, op] of plan.entries()) {
    try {
      switch (op.op) {
        case 'createPage':
        case 'createNode': {
          checkName(op.name);
          const parent = await container(op.parentPath);
          const ltree = joinLtree(parent.ltree, op.name);
          const kind: NodeKind = op.op === 'createPage' ? 'page' : op.kind;
          const storage: NodeStorage = parent.node.storage === 'git' ? 'git' : 'db';
          await authorize('create', parent.target);
          await authorize('create', { path: ltree, kind, storage });
          await free(ltree);
          if (op.body !== undefined) {
            await authorize('write', { path: ltree, kind, storage });
            checkBody(kind, op.body);
          }
          tree.apply({ type: 'create', path: ltree, node: { kind, storage, original: null } });
          break;
        }
        case 'updateBody':
        case 'patchBlocks':
        case 'updateMeta': {
          const { node, target } = await existing(op.path);
          await authorize('write', target);
          if (node.storage === 'git' || node.storage === 'virtual') {
            throw invalid(`il contenuto di questo nodo non si modifica qui (${node.storage})`);
          }
          if (op.op === 'updateBody') checkBody(node.kind, op.body);
          if (op.op === 'patchBlocks' && node.kind !== 'page' && node.kind !== 'layout') {
            throw invalid(`i nodi di tipo "${node.kind}" non hanno blocchi`);
          }
          if (op.op === 'updateMeta' && node.kind !== 'page') {
            throw invalid(`solo le pagine hanno metadati (tipo "${node.kind}")`);
          }
          break;
        }
        case 'move': {
          const source = await existing(op.path);
          await relocate(
            source,
            op.newParentPath,
            op.name ?? lastSegment(source.ltree),
            'spostare',
          );
          break;
        }
        case 'rename': {
          const source = await existing(op.path);
          await relocate(source, toPublicPath(parentLtree(source.ltree)), op.name, 'rinominare');
          break;
        }
        case 'delete': {
          const { ltree, node, target } = await existing(op.path);
          await authorize('delete', target);
          notProtected(ltree, node, 'eliminare');
          tree.apply({ type: 'delete', path: ltree });
          break;
        }
        case 'publish':
        case 'unpublish': {
          const { target } = await existing(op.path);
          await authorize('publish', target);
          break;
        }
      }
    } catch (error) {
      if (error instanceof OperationProblem) {
        issues.push({ index, op: describeOperation(op), kind: error.kind, message: error.message });
      } else if (error instanceof ValidationError) {
        issues.push({ index, op: describeOperation(op), kind: 'invalid', message: error.message });
      } else throw error;
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------------------
// Execution: one transaction, through the same services the UI uses.

function issueKind(error: unknown): PlanIssueKind {
  if (error instanceof AuthzError) return 'authz';
  if (error instanceof ConflictError) return 'conflict';
  if (error instanceof NotFoundError) return 'not-found';
  return 'invalid';
}

class DryRunRollback extends Error {
  constructor(readonly result: PlanResult) {
    super('dry run');
  }
}

const emptyBody = (kind: NodeKind): unknown =>
  kind === 'layout' ? { blocks: [] } : { meta: {}, blocks: [] };

/**
 * Applies a plan of operations on several nodes all together or not at all (FR-63).
 * Everything is validated first (authorization, schemas, paths as they will be after the
 * previous operations); then the plan runs in a single transaction. With `dryRun` the
 * transaction is rolled back and the result carries a preview of each changed body.
 */
export async function executePlan(
  db: Executor,
  principal: Principal,
  env: Env,
  plan: PlanOperation[],
  options: ExecutePlanOptions = {},
): Promise<PlanResult> {
  const parsed = planSchema.safeParse(plan, { error: z.locales.it().localeError });
  if (!parsed.success) {
    throw new PlanError(
      parsed.error.issues.map((issue) => {
        const [index] = issue.path;
        return {
          index: typeof index === 'number' ? index : -1,
          op: typeof index === 'number' ? String(plan[index]?.op ?? '?') : 'piano',
          kind: 'invalid' as const,
          message: `${formatPath(issue.path.slice(1)) || 'operazione'}: ${issue.message}`,
        };
      }),
    );
  }
  const operations = parsed.data;
  const issues = await validatePlan(db, principal, env, operations);
  if (issues.length > 0) throw new PlanError(issues);

  const save: SaveOptions = {
    conversationId: options.conversationId,
    viaAgent: options.viaAgent,
  };

  const run = async (tx: Executor): Promise<PlanResult> => {
    const touched = new Set<string>();
    const created = new Set<string>();
    const base = new Map<string, { version: number | null; body: unknown; kind: NodeKind }>();
    const versions: { nodeId: string; version: number; versionId: number }[] = [];
    const published = new Set<string>();
    const unpublished = new Set<string>();
    const revalidate = new Set<string>();

    /** Remembers the content before the plan the first time a node's content changes. */
    const rememberBase = async (nodeId: string, kind: NodeKind) => {
      if (base.has(nodeId)) return;
      const latest = await latestVersion(tx, nodeId, env);
      base.set(nodeId, { version: latest?.version ?? null, body: latest?.body ?? null, kind });
    };
    const write = async (publicPath: string, body: unknown, expectedVersion?: number) => {
      const node = await requireNode(tx, parsePath(publicPath), env);
      await rememberBase(node.id, node.kind);
      const version = await saveDraft(tx, principal, env, publicPath, body, {
        ...save,
        expectedVersion,
      });
      touched.add(node.id);
      versions.push({ nodeId: node.id, version: version.version, versionId: version.id });
    };
    const current = async (publicPath: string) => {
      const node = await requireNode(tx, parsePath(publicPath), env);
      const latest = await latestVersion(tx, node.id, env);
      return {
        node,
        body: (latest?.body ?? emptyBody(node.kind)) as { meta?: object; blocks?: Block[] },
        version: latest?.version ?? 0,
      };
    };

    for (const [index, op] of operations.entries()) {
      try {
        switch (op.op) {
          case 'createPage':
          case 'createNode': {
            const kind = op.op === 'createPage' ? 'page' : op.kind;
            const node = await createNode(tx, principal, env, op.parentPath, {
              name: op.name,
              kind,
            });
            touched.add(node.id);
            created.add(node.id);
            if (op.body !== undefined) await write(node.path, op.body);
            break;
          }
          case 'updateBody':
            await write(op.path, op.body, op.expectedVersion);
            break;
          case 'patchBlocks': {
            const { body, version } = await current(op.path);
            const patched = applyBlockPatch(body.blocks ?? [], op.operations);
            if (!patched.ok) throw new ValidationError(formatIssues(patched.errors));
            await write(op.path, { ...body, blocks: patched.value }, op.expectedVersion ?? version);
            break;
          }
          case 'updateMeta': {
            const { body, version } = await current(op.path);
            const meta: Record<string, unknown> = { ...(body.meta ?? {}) };
            for (const [key, value] of Object.entries(op.meta)) {
              if (value === null) delete meta[key];
              else meta[key] = value;
            }
            await write(op.path, { ...body, meta }, op.expectedVersion ?? version);
            break;
          }
          case 'move':
          case 'rename': {
            const node =
              op.op === 'move'
                ? await moveNode(tx, principal, env, op.path, op.newParentPath, {
                    name: op.name,
                    expectedVersion: op.expectedVersion,
                  })
                : await renameNode(tx, principal, env, op.path, op.name, {
                    expectedVersion: op.expectedVersion,
                  });
            touched.add(node.id);
            revalidate.add(toPublicPath(parsePath(op.path)));
            revalidate.add(node.path);
            break;
          }
          case 'delete': {
            const node = await deleteNode(tx, principal, env, op.path, {
              expectedVersion: op.expectedVersion,
            });
            touched.add(node.id);
            revalidate.add(node.path);
            break;
          }
          case 'publish': {
            const node = await requireNode(tx, parsePath(op.path), env);
            if (options.validateRendered) {
              const version = await resolveVersion(tx, node, env, op.version ?? 'latest');
              const { errors } = await options.validateRendered(node.path, version.body);
              if (errors.length > 0) {
                throw new PlanError([
                  {
                    index,
                    op: describeOperation(op),
                    kind: 'rendering',
                    message: `la pagina non rispetta le regole HTML:\n${errors.map((e) => `  · ${e}`).join('\n')}`,
                  },
                ]);
              }
            }
            await publish(tx, principal, env, op.path, { version: op.version });
            touched.add(node.id);
            published.add(node.id);
            break;
          }
          case 'unpublish': {
            const result = await unpublish(tx, principal, env, op.path);
            const node = await requireNode(tx, parsePath(op.path), env);
            touched.add(node.id);
            if (result.versionId !== null) unpublished.add(node.id);
            break;
          }
        }
      } catch (error) {
        if (error instanceof PlanError) throw error;
        throw new PlanError(
          [
            {
              index,
              op: describeOperation(op),
              kind: issueKind(error),
              message: error instanceof Error ? error.message : String(error),
            },
          ],
          error,
        );
      }
    }

    // Final paths: later moves may have changed the path of nodes touched earlier.
    const ids = [...touched];
    const rows =
      ids.length > 0
        ? await tx
            .select({ id: schema.nodes.id, path: schema.nodes.path })
            .from(schema.nodes)
            .where(inArray(schema.nodes.id, ids))
        : [];
    const pathOf = new Map(rows.map((r) => [r.id, toPublicPath(r.path)]));
    for (const id of [...published, ...unpublished]) revalidate.add(pathOf.get(id)!);

    const result: PlanResult = {
      dryRun: options.dryRun ?? false,
      touched: ids.map((id) => pathOf.get(id)!),
      versions: versions.map((v) => ({
        path: pathOf.get(v.nodeId)!,
        version: v.version,
        versionId: v.versionId,
      })),
      published: [...published].map((id) => pathOf.get(id)!),
      unpublished: [...unpublished].map((id) => pathOf.get(id)!),
      revalidate: [...revalidate],
    };
    if (options.dryRun) {
      const preview: PagePreview[] = [];
      for (const [nodeId, before] of base) {
        const after = await latestVersion(tx, nodeId, env);
        preview.push({
          path: pathOf.get(nodeId)!,
          kind: before.kind,
          created: created.has(nodeId),
          baseVersion: before.version,
          body: after?.body ?? null,
          diff: diffBodies(before.body, after?.body ?? null),
        });
      }
      result.preview = preview;
    }
    return result;
  };

  let result: PlanResult;
  try {
    result = await db.transaction(async (tx) => {
      const outcome = await run(tx);
      if (options.dryRun) throw new DryRunRollback(outcome);
      return outcome;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.result;
    throw error;
  }

  if (options.onPublished && result.revalidate.length > 0) {
    try {
      await options.onPublished(result.revalidate, env);
    } catch (error) {
      result.hookError = error instanceof Error ? error.message : String(error);
    }
  }
  return result;
}
