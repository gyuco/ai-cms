import { writeAudit, type Executor } from '@ai-cms/audit';
import {
  AuthzError,
  requireAuthorized,
  type Action,
  type Decision,
  type Env,
  type NodeTarget,
  type Principal,
} from '@ai-cms/authz';

/**
 * `requireAuthorized` plus the audit of denials (TECHNICAL §6.8). `auditAction` is the
 * service-level action, e.g. `node.move`.
 */
export async function authorizeOrAudit(
  db: Executor,
  principal: Principal,
  action: Action,
  target: NodeTarget,
  env: Env,
  auditAction: string,
): Promise<Decision> {
  try {
    return requireAuthorized(principal, action, target, env);
  } catch (error) {
    if (error instanceof AuthzError) {
      await writeAudit(db, {
        actorUid: principal.uid,
        agent: principal.agent?.name ?? null,
        action: auditAction,
        nodePath: target.path,
        env,
        outcome: 'denied',
        details: { permission: action, code: error.code, message: error.message },
      });
    }
    throw error;
  }
}

/** Audit row for a completed change. Pass the transaction so both commit together. */
export async function auditOk(
  db: Executor,
  principal: Principal,
  env: Env,
  auditAction: string,
  nodePath: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await writeAudit(db, {
    actorUid: principal.uid,
    agent: principal.agent?.name ?? null,
    action: auditAction,
    nodePath,
    env,
    outcome: 'ok',
    details: details ?? null,
  });
}
