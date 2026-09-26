import {
  agentRestriction,
  checkStatus,
  scopeRestriction,
  systemInvariants,
  type Denial,
} from './constraints.ts';
import { fromLtree } from './paths.ts';
import type { Action, AuthzPolicy, Decision, Env, NodeTarget, Principal } from './types.ts';

/**
 * Phase 1 policy: every active user is an administrator. Runs after the system invariants,
 * the agent profile and the scope, which `authorize` evaluates first.
 */
export const allAdminsPolicy: AuthzPolicy = {
  check(principal) {
    if (principal.status !== 'active') {
      const denial = checkStatus(principal) as Denial;
      return { allowed: false, ...denial, steps: [`Politica "tutti admin": ${denial.message}`] };
    }
    return {
      allowed: true,
      code: 'all-admins',
      message: 'Consentito: in questa fase ogni utente attivo è amministratore.',
      steps: ['Politica "tutti admin": utente attivo, consentito.'],
    };
  },
};

export const defaultPolicy: AuthzPolicy = allAdminsPolicy;

export class AuthzError extends Error {
  readonly decision: Decision;

  constructor(decision: Decision) {
    super(decision.message);
    this.name = 'AuthzError';
    this.decision = decision;
  }

  get code(): string {
    return this.decision.code;
  }
}

type Stage = [label: string, run: () => Denial | null];

/**
 * The single entry point for authorization (TECHNICAL §6.8). Evaluates, in order: user status,
 * system invariants (§6.3, root included), agent profile, conversation scope, then the policy.
 */
export function authorize(
  principal: Principal,
  action: Action,
  target: NodeTarget,
  env: Env,
  policy: AuthzPolicy = defaultPolicy,
): Decision {
  const who = principal.agent
    ? `${principal.username} (uid ${principal.uid}) tramite l'agente "${principal.agent.name}"`
    : `${principal.username} (uid ${principal.uid})`;
  const steps = [`Richiesta: ${who}, azione "${action}" su ${fromLtree(target.path)} in ${env}.`];

  const stages: Stage[] = [
    ['Stato utente', () => checkStatus(principal)],
    ['Vincoli di sistema', () => systemInvariants(principal, action, target, env)],
    ['Profilo agente', () => agentRestriction(principal, action, target, env)],
    ['Ambito della conversazione', () => scopeRestriction(principal, target)],
  ];
  for (const [label, run] of stages) {
    const denial = run();
    if (denial) {
      steps.push(`${label}: negato (${denial.code}). ${denial.message}`);
      return { allowed: false, code: denial.code, message: denial.message, steps };
    }
    steps.push(`${label}: superato.`);
  }

  const decision = policy.check(principal, action, target, env);
  return { ...decision, steps: [...steps, ...decision.steps] };
}

/** Like `authorize`, but throws `AuthzError` when the action is denied. */
export function requireAuthorized(
  principal: Principal,
  action: Action,
  target: NodeTarget,
  env: Env,
  policy: AuthzPolicy = defaultPolicy,
): Decision {
  const decision = authorize(principal, action, target, env, policy);
  if (!decision.allowed) throw new AuthzError(decision);
  return decision;
}
