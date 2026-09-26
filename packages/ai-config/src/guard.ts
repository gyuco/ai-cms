import { writeAudit, type Executor } from '@ai-cms/audit';
import {
  AuthzError,
  requireAuthorized,
  type Action,
  type Env,
  type NodeTarget,
  type Principal,
} from '@ai-cms/authz';

/** System configuration is shared by both environments; it is checked as a prod node. */
export const CONFIG_ENV: Env = 'prod';

/**
 * Authorizes an action on a `/system/...` node and records a denial in the audit log before
 * rethrowing `AuthzError`. Allowed actions are audited by the caller, together with the change.
 */
export async function guard(
  db: Executor,
  principal: Principal,
  action: Action,
  target: NodeTarget,
  auditAction: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    requireAuthorized(principal, action, target, CONFIG_ENV);
  } catch (err) {
    if (err instanceof AuthzError) {
      await writeAudit(db, {
        actorUid: principal.uid,
        agent: principal.agent?.name ?? null,
        action: auditAction,
        nodePath: target.path,
        env: CONFIG_ENV,
        outcome: 'denied',
        details: { ...details, code: err.code },
      });
    }
    throw err;
  }
}

export class ConfigError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.status = status;
  }
}
