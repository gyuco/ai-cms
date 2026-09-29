/**
 * Plans and confirmations of the content agent (E9.3, TECHNICAL §7.5 and §10.4): the
 * operations proposed in a turn accumulate in a plan; the user sees a preview and confirms
 * before anything destructive is executed, and the confirmed plan runs in one transaction
 * (FR-63) through the same `executePlan` the tree services already validate against (E5.7).
 */
import type { Env, Principal } from '@ai-cms/authz';
import {
  executePlan,
  type ExecutePlanOptions,
  type PagePreview,
  type PlanOperation,
  type PlanResult,
} from '@ai-cms/content/service';
import type { Executor } from '@ai-cms/tree';

/** Accumulates the operations the agent proposes during one turn, in the order proposed. */
export interface PlanSession {
  propose(operation: PlanOperation): void;
  operations(): readonly PlanOperation[];
  isEmpty(): boolean;
  /** Discards the accumulated operations without executing them ("Annulla", TECHNICAL §10.4). */
  clear(): void;
}

export function createPlanSession(): PlanSession {
  let operations: PlanOperation[] = [];
  return {
    propose(operation) {
      operations.push(operation);
    },
    operations: () => [...operations],
    isEmpty: () => operations.length === 0,
    clear() {
      operations = [];
    },
  };
}

/** Operations that are always destructive on their own, whatever they touch (FR-06). */
export function isDestructiveOperation(operation: PlanOperation): boolean {
  return operation.op === 'delete';
}

/** True when at least one proposed operation is destructive by itself. */
export function planIsDestructive(operations: readonly PlanOperation[]): boolean {
  return operations.some(isDestructiveOperation);
}

/**
 * A "massive overwrite" (FR-06) for a page: it had blocks and the plan would leave it with
 * none. `updateBody` and `patchBlocks` are not destructive by their operation name alone —
 * unlike `delete`, most calls just edit a paragraph — so this looks at the dry-run preview
 * instead of the operation, the only place that knows what the page actually had before.
 */
export function previewIsMassiveOverwrite(preview: PagePreview): boolean {
  if (preview.created) return false;
  if (preview.diff.blocks.removed.length === 0) return false;
  const after = (preview.body as { blocks?: unknown[] } | null)?.blocks;
  return Array.isArray(after) && after.length === 0;
}

/**
 * Whether the plan needs an explicit confirmation before it runs for real, instead of the
 * agent executing it on its own say. Without a preview this only sees the destructive
 * operations; passing the dry-run `PlanResult` also catches a massive overwrite that no
 * single operation name would reveal.
 */
export function requiresConfirmation(
  operations: readonly PlanOperation[],
  preview?: PlanResult,
): boolean {
  if (planIsDestructive(operations)) return true;
  return (preview?.preview ?? []).some(previewIsMassiveOverwrite);
}

/**
 * Dry-runs the accumulated plan so the widget can render the in-place preview (TECHNICAL
 * §10.4): nothing is committed, and the transaction that built the preview is rolled back.
 */
export function previewContentPlan(
  db: Executor,
  principal: Principal,
  env: Env,
  session: PlanSession,
  options: Omit<ExecutePlanOptions, 'dryRun'> = {},
): Promise<PlanResult> {
  return executePlan(db, principal, env, [...session.operations()], {
    ...options,
    dryRun: true,
  });
}

/**
 * Executes the accumulated plan for real, in one transaction (FR-63), and clears the
 * session: a confirmed plan does not linger to be confirmed again.
 */
export async function confirmContentPlan(
  db: Executor,
  principal: Principal,
  env: Env,
  session: PlanSession,
  options: Omit<ExecutePlanOptions, 'dryRun'> = {},
): Promise<PlanResult> {
  const result = await executePlan(db, principal, env, [...session.operations()], {
    ...options,
    dryRun: false,
  });
  session.clear();
  return result;
}
