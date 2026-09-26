export const ACTIONS = [
  'read',
  'list',
  'traverse',
  'write',
  'create',
  'delete',
  'publish',
  'manage',
] as const;

export type Action = (typeof ACTIONS)[number];

/** Single-letter permission for each action, as in TECHNICAL §6.1 (`rlxwcdpm`). */
export type Perm = 'r' | 'l' | 'x' | 'w' | 'c' | 'd' | 'p' | 'm';

export const ACTION_LETTER: Readonly<Record<Action, Perm>> = {
  read: 'r',
  list: 'l',
  traverse: 'x',
  write: 'w',
  create: 'c',
  delete: 'd',
  publish: 'p',
  manage: 'm',
};

export type Env = 'prod' | 'staging';

export type Storage = 'db' | 'git' | 's3' | 'virtual';

export interface NodeTarget {
  /** Node path in ltree form: `''` is the root, e.g. `site.pages.blog`. */
  path: string;
  kind: string;
  storage: Storage;
}

export interface AgentRule {
  /** ltree path prefix; `''` matches the whole tree. */
  path: string;
  actions: Action[];
  /** When present, the rule only matches nodes with one of these storages. */
  storages?: Storage[];
}

export interface AgentProfile {
  name: string;
  envs: Env[];
  allow: AgentRule[];
  deny?: AgentRule[];
}

export type UserStatus = 'invited' | 'active' | 'suspended' | 'deleted';

export interface Principal {
  uid: number;
  username: string;
  status: UserStatus;
  /** Present when an AI agent acts on behalf of the user (FR-82). */
  agent?: AgentProfile;
  /** Per-conversation restriction: ltree path prefixes (FR-86). */
  scope?: string[];
}

export interface Decision {
  allowed: boolean;
  /** Machine-readable reason, e.g. `invariant-I1` or `all-admins`. */
  code: string;
  /** Italian explanation that can be shown to the user. */
  message: string;
  /** Step-by-step trace of the evaluation (FR-88), in Italian. */
  steps: string[];
}

export interface AuthzPolicy {
  check(principal: Principal, action: Action, target: NodeTarget, env: Env): Decision;
}
