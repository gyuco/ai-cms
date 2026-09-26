import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ACTION_LETTER,
  AuthzError,
  allAdminsPolicy,
  authorize,
  contentAgentProfile,
  devAgentProfile,
  requireAuthorized,
  type Action,
  type AgentProfile,
  type AuthzPolicy,
  type Env,
  type NodeTarget,
  type Principal,
} from './index.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };
const alice: Principal = { uid: 1000, username: 'alice', status: 'active' };
const asAgent = (profile: AgentProfile, user: Principal = alice): Principal => ({
  ...user,
  agent: profile,
});
const contentAgent = asAgent(contentAgentProfile);
const devAgent = asAgent(devAgentProfile);
const rootContentAgent = asAgent(contentAgentProfile, root);

const node = (path: string, storage: NodeTarget['storage'] = 'db', kind = 'page'): NodeTarget => ({
  path,
  kind,
  storage,
});
const page = node('site.pages.blog');
const image = node('site.media.logo', 's3', 'file');
const codeFile = node('site.pages.catalogo.page', 'git', 'code');
const apiCode = node('code.api.contatti', 'git', 'code');
const collection = node('data.collections.prodotti', 'db', 'collection');
const audit = node('system.audit', 'virtual', 'folder');
const auditEntry = node('system.audit.42', 'virtual', 'entry');
const secret = node('system.secrets.ai.anthropic', 'db', 'secret');
const systemNode = node('system.agents.content-agent', 'db', 'config');
const rootNode = node('', 'virtual', 'folder');

const MUTATIONS: Action[] = ['write', 'create', 'delete'];

describe('ACTION_LETTER', () => {
  it('maps every action to its rlxwcdpm letter', () => {
    expect(ACTIONS.map((action) => ACTION_LETTER[action]).join('')).toBe('rlxwcdpm');
  });
});

describe('all-admins policy', () => {
  it.each(ACTIONS)('allows %s to an active user on ordinary nodes', (action) => {
    for (const env of ['prod', 'staging'] as Env[]) {
      const decision = authorize(alice, action, page, env);
      expect(decision).toMatchObject({ allowed: true, code: 'all-admins' });
    }
  });

  it('allows everything on code in staging', () => {
    for (const action of ACTIONS) {
      expect(authorize(alice, action, codeFile, 'staging').allowed).toBe(true);
    }
  });

  it.each(['invited', 'suspended', 'deleted'] as const)('denies a %s user', (status) => {
    const decision = authorize({ ...alice, status }, 'read', page, 'staging');
    expect(decision).toMatchObject({ allowed: false, code: 'inactive-user' });
    expect(decision.message).toContain(status);
    expect(authorize({ ...root, status }, 'read', page, 'staging').allowed).toBe(false);
  });

  it('denies an inactive user when called directly', () => {
    const decision = allAdminsPolicy.check({ ...alice, status: 'suspended' }, 'read', page, 'prod');
    expect(decision).toMatchObject({ allowed: false, code: 'inactive-user' });
    expect(decision.steps[0]).toContain('tutti admin');
  });
});

describe('system invariants hold for root too', () => {
  const cases: [string, Principal, Action, NodeTarget, Env, string][] = [
    // I1: code and schemas are read-only in prod
    ...MUTATIONS.flatMap((action): [string, Principal, Action, NodeTarget, Env, string][] => [
      ['I1 code', root, action, codeFile, 'prod', 'invariant-I1'],
      ['I1 api code', alice, action, apiCode, 'prod', 'invariant-I1'],
      ['I1 schema', root, action, collection, 'prod', 'invariant-I1'],
    ]),
    // I4: no agent on secrets, no agent manage on /system
    ...ACTIONS.map((action): [string, Principal, Action, NodeTarget, Env, string] => [
      'I4 secrets',
      rootContentAgent,
      action,
      secret,
      'staging',
      'invariant-I4',
    ]),
    ['I4 secrets dev', asAgent(devAgentProfile, root), 'read', secret, 'staging', 'invariant-I4'],
    ['I4 system manage', rootContentAgent, 'manage', systemNode, 'prod', 'invariant-I4'],
    ['I4 system root manage', devAgent, 'manage', node('system'), 'staging', 'invariant-I4'],
    // I5: dev-agent never in prod
    ['I5 dev in prod', asAgent(devAgentProfile, root), 'read', page, 'prod', 'invariant-I5'],
    // I6: content-agent never mutates code or schemas
    ...MUTATIONS.flatMap((action): [string, Principal, Action, NodeTarget, Env, string][] => [
      ['I6 code', rootContentAgent, action, codeFile, 'staging', 'invariant-I6'],
      ['I6 schema', rootContentAgent, action, collection, 'staging', 'invariant-I6'],
    ]),
    // I7: audit is read-only
    ...(['write', 'create', 'delete', 'publish', 'manage'] as Action[]).flatMap(
      (action): [string, Principal, Action, NodeTarget, Env, string][] => [
        ['I7 audit', root, action, audit, 'staging', 'invariant-I7'],
        ['I7 audit entry', root, action, auditEntry, 'prod', 'invariant-I7'],
      ],
    ),
  ];

  it.each(cases)('%s: %s %s on %j in %s → %s', (_label, principal, action, target, env, code) => {
    const decision = authorize(principal, action, target, env);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(code);
    expect(decision.message.length).toBeGreaterThan(0);
    expect(decision.steps.at(-1)).toContain(code);
  });

  it('I1 does not block reading code in prod, nor editing it in staging', () => {
    expect(authorize(root, 'read', codeFile, 'prod').allowed).toBe(true);
    expect(authorize(root, 'publish', codeFile, 'prod').allowed).toBe(true);
    expect(authorize(root, 'write', codeFile, 'staging').allowed).toBe(true);
    expect(authorize(root, 'write', collection, 'staging').allowed).toBe(true);
  });

  it('I1 message explains the way forward', () => {
    expect(authorize(root, 'write', codeFile, 'prod').message).toBe(
      'Il codice e gli schemi delle collezioni non si possono modificare in produzione: lavora in staging e pubblica con una release.',
    );
  });

  it('I7 still allows reading the audit log', () => {
    for (const action of ['read', 'list', 'traverse'] as Action[]) {
      expect(authorize(root, action, auditEntry, 'prod').allowed).toBe(true);
    }
  });

  it('I4 only concerns agents: root can read secrets and manage /system', () => {
    expect(authorize(root, 'read', secret, 'prod').allowed).toBe(true);
    expect(authorize(root, 'manage', systemNode, 'prod').allowed).toBe(true);
  });

  it('the policy cannot override an invariant', () => {
    const permissive: AuthzPolicy = {
      check: () => ({ allowed: true, code: 'yes', message: 'sì', steps: [] }),
    };
    expect(authorize(root, 'write', codeFile, 'prod', permissive).allowed).toBe(false);
  });
});

describe('agent profiles: agent ⊆ user', () => {
  it('content-agent can manage site content in both envs', () => {
    for (const env of ['prod', 'staging'] as Env[]) {
      for (const action of [
        'read',
        'list',
        'traverse',
        'write',
        'create',
        'delete',
        'publish',
      ] as Action[]) {
        expect(authorize(contentAgent, action, page, env).allowed).toBe(true);
        expect(authorize(contentAgent, action, image, env).allowed).toBe(true);
      }
    }
  });

  it.each([
    ['manage on site', 'manage', page, 'agent-profile'],
    ['read outside site', 'read', node('data.collections.prodotti.items'), 'agent-profile'],
    ['read code (git storage)', 'read', codeFile, 'agent-profile'],
    ['read root', 'list', rootNode, 'agent-profile'],
  ] as [string, Action, NodeTarget, string][])(
    'content-agent is denied %s',
    (_label, action, target, code) => {
      expect(authorize(contentAgent, action, target, 'staging')).toMatchObject({
        allowed: false,
        code,
      });
    },
  );

  it('dev-agent works on site, data and code in staging', () => {
    for (const target of [page, codeFile, apiCode, collection]) {
      for (const action of ['read', 'write', 'create', 'delete'] as Action[]) {
        expect(authorize(devAgent, action, target, 'staging').allowed).toBe(true);
      }
    }
  });

  it('dev-agent is blocked in prod, whatever the action', () => {
    for (const action of ACTIONS) {
      const decision = authorize(devAgent, action, page, 'prod');
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('invariant-I5');
    }
  });

  it('dev-agent has no manage and no access outside its prefixes', () => {
    expect(authorize(devAgent, 'manage', page, 'staging').code).toBe('agent-profile');
    expect(authorize(devAgent, 'read', node('system.ai.roles'), 'staging').code).toBe(
      'agent-profile',
    );
  });

  it('a custom profile only operates in its envs', () => {
    const custom: AgentProfile = {
      name: 'translate',
      envs: ['staging'],
      allow: [{ path: '', actions: ['read'] }],
    };
    expect(authorize(asAgent(custom), 'read', page, 'prod')).toMatchObject({
      allowed: false,
      code: 'agent-env',
    });
    expect(
      authorize(asAgent({ ...custom, envs: ['prod'] }), 'read', page, 'staging').message,
    ).toContain('staging');
    expect(authorize(asAgent(custom), 'read', page, 'staging').allowed).toBe(true);
  });

  it('deny rules win over allow rules', () => {
    const custom: AgentProfile = {
      name: 'translate',
      envs: ['prod', 'staging'],
      allow: [{ path: 'site', actions: ['read', 'write'] }],
      deny: [{ path: 'site.pages.legal', actions: ['write'] }],
    };
    const agent = asAgent(custom);
    expect(authorize(agent, 'write', page, 'prod').allowed).toBe(true);
    expect(authorize(agent, 'write', node('site.pages.legal.privacy'), 'prod')).toMatchObject({
      allowed: false,
      code: 'agent-profile-deny',
    });
    expect(authorize(agent, 'read', node('site.pages.legal.privacy'), 'prod').allowed).toBe(true);
  });

  it('the agent never exceeds the user: an inactive user denies the agent too', () => {
    const suspended = asAgent(contentAgentProfile, { ...alice, status: 'suspended' });
    expect(authorize(suspended, 'read', page, 'prod').code).toBe('inactive-user');
  });

  it('the agent never exceeds the user: a restrictive policy applies to the agent', () => {
    const readOnly: AuthzPolicy = {
      check: (_p, action) =>
        action === 'read'
          ? { allowed: true, code: 'ro', message: 'ok', steps: ['ro'] }
          : { allowed: false, code: 'ro-deny', message: 'no', steps: ['ro-deny'] },
    };
    expect(authorize(contentAgent, 'read', page, 'prod', readOnly).allowed).toBe(true);
    expect(authorize(contentAgent, 'write', page, 'prod', readOnly)).toMatchObject({
      allowed: false,
      code: 'ro-deny',
    });
  });
});

describe('conversation scope (FR-86)', () => {
  const scoped: Principal = { ...contentAgent, scope: ['site.pages.blog'] };

  it('allows targets under a scope prefix', () => {
    expect(authorize(scoped, 'write', page, 'prod').allowed).toBe(true);
    expect(authorize(scoped, 'write', node('site.pages.blog.post-1'), 'prod').allowed).toBe(true);
  });

  it('denies targets outside every prefix', () => {
    const decision = authorize(scoped, 'write', node('site.pages.about'), 'prod');
    expect(decision).toMatchObject({ allowed: false, code: 'scope' });
    expect(decision.message).toContain('/site/pages/blog');
  });

  it('applies to human users as well, with multiple prefixes', () => {
    const user: Principal = { ...alice, scope: ['site.pages.blog', 'site.media'] };
    expect(authorize(user, 'read', image, 'prod').allowed).toBe(true);
    expect(authorize(user, 'read', collection, 'prod').code).toBe('scope');
  });

  it('an empty scope allows nothing', () => {
    const decision = authorize({ ...alice, scope: [] }, 'read', page, 'prod');
    expect(decision.code).toBe('scope');
    expect(decision.message).toContain('nessun percorso');
  });

  it("'' scope covers the whole tree", () => {
    expect(authorize({ ...alice, scope: [''] }, 'read', collection, 'prod').allowed).toBe(true);
  });
});

describe('decision trace', () => {
  it('records each stage and the policy', () => {
    const decision = authorize(contentAgent, 'write', page, 'prod');
    expect(decision.steps).toHaveLength(6);
    expect(decision.steps[0]).toContain('content-agent');
    expect(decision.steps[0]).toContain('/site/pages/blog');
    expect(decision.steps.at(-1)).toContain('tutti admin');
  });
});

describe('requireAuthorized', () => {
  it('returns the decision when allowed', () => {
    expect(requireAuthorized(alice, 'read', page, 'prod').allowed).toBe(true);
  });

  it('throws AuthzError carrying the decision when denied', () => {
    let error: unknown;
    try {
      requireAuthorized(root, 'delete', codeFile, 'prod');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AuthzError);
    const authzError = error as AuthzError;
    expect(authzError.code).toBe('invariant-I1');
    expect(authzError.decision.allowed).toBe(false);
    expect(authzError.message).toBe(authzError.decision.message);
    expect(authzError.name).toBe('AuthzError');
  });

  it('uses the given policy', () => {
    const denyAll: AuthzPolicy = {
      check: () => ({ allowed: false, code: 'nope', message: 'no', steps: [] }),
    };
    expect(() => requireAuthorized(alice, 'read', page, 'prod', denyAll)).toThrow(AuthzError);
  });
});
