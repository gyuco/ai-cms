import { fromLtree, isUnder } from './paths.ts';
import { ruleMatches } from './profiles.ts';
import { ACTION_LETTER, type Action, type Env, type NodeTarget, type Principal } from './types.ts';

export interface Denial {
  code: string;
  message: string;
}

const MUTATIONS: ReadonlySet<Action> = new Set(['write', 'create', 'delete']);
const READ_ONLY: ReadonlySet<Action> = new Set(['read', 'list', 'traverse']);

/** Code (git storage) and collection schemas: the nodes that change only through a release. */
function isCodeOrSchema(target: NodeTarget): boolean {
  return target.storage === 'git' || target.kind === 'collection';
}

function describe(action: Action, target: NodeTarget): string {
  return `azione "${action}" (${ACTION_LETTER[action]}) su ${fromLtree(target.path)}`;
}

export function checkStatus(principal: Principal): Denial | null {
  if (principal.status === 'active') return null;
  return {
    code: 'inactive-user',
    message: `L'utente ${principal.username} non è attivo (stato: ${principal.status}): non può compiere azioni.`,
  };
}

/**
 * System invariants (TECHNICAL §6.3). They hold for everyone, root included, and no policy
 * can override them.
 */
export function systemInvariants(
  principal: Principal,
  action: Action,
  target: NodeTarget,
  env: Env,
): Denial | null {
  if (isUnder(target.path, 'system.audit') && !READ_ONLY.has(action)) {
    return {
      code: 'invariant-I7',
      message:
        'Il registro di audit è in sola lettura per tutti, amministratori compresi: si può solo consultare.',
    };
  }

  if (env === 'prod' && MUTATIONS.has(action) && isCodeOrSchema(target)) {
    return {
      code: 'invariant-I1',
      message:
        'Il codice e gli schemi delle collezioni non si possono modificare in produzione: lavora in staging e pubblica con una release.',
    };
  }

  const agent = principal.agent;
  if (!agent) return null;

  if (isUnder(target.path, 'system.secrets')) {
    return {
      code: 'invariant-I4',
      message: `Gli agenti AI non possono accedere ai segreti (${fromLtree(target.path)}).`,
    };
  }
  if (action === 'manage' && isUnder(target.path, 'system')) {
    return {
      code: 'invariant-I4',
      message: `Gli agenti AI non possono gestire i permessi o la configurazione di sistema (${fromLtree(target.path)}).`,
    };
  }

  if (agent.name === 'dev-agent' && env === 'prod') {
    return {
      code: 'invariant-I5',
      message:
        "L'agente sviluppatore lavora solo in staging: le modifiche arrivano in produzione con una release.",
    };
  }

  if (agent.name === 'content-agent' && MUTATIONS.has(action) && isCodeOrSchema(target)) {
    return {
      code: 'invariant-I6',
      message:
        "L'agente contenuti non può modificare il codice né gli schemi delle collezioni: serve l'agente sviluppatore, in staging.",
    };
  }

  return null;
}

/** Agent profile as a mask (FR-82): the action must match an allow rule and no deny rule. */
export function agentRestriction(
  principal: Principal,
  action: Action,
  target: NodeTarget,
  env: Env,
): Denial | null {
  const agent = principal.agent;
  if (!agent) return null;

  if (!agent.envs.includes(env)) {
    return {
      code: 'agent-env',
      message: `Il profilo dell'agente "${agent.name}" non consente di operare in ${env === 'prod' ? 'produzione' : 'staging'}.`,
    };
  }
  const denied = agent.deny?.find((rule) => ruleMatches(rule, action, target));
  if (denied) {
    return {
      code: 'agent-profile-deny',
      message: `Il profilo dell'agente "${agent.name}" vieta l'${describe(action, target)}.`,
    };
  }
  if (!agent.allow.some((rule) => ruleMatches(rule, action, target))) {
    return {
      code: 'agent-profile',
      message: `Il profilo dell'agente "${agent.name}" non consente l'${describe(action, target)}.`,
    };
  }
  return null;
}

/** Per-conversation scope (FR-86): the target must lie under one of the prefixes. */
export function scopeRestriction(principal: Principal, target: NodeTarget): Denial | null {
  const scope = principal.scope;
  if (scope === undefined) return null;
  if (scope.some((prefix) => isUnder(target.path, prefix))) return null;
  const allowed = scope.map(fromLtree).join(', ') || 'nessun percorso';
  return {
    code: 'scope',
    message: `${fromLtree(target.path)} è fuori dall'ambito di questa conversazione (${allowed}).`,
  };
}
