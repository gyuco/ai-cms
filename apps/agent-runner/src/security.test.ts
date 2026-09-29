import { buildClaudeCodeEnv } from '@ai-cms/ai';
import { chmod, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { git } from './commit.ts';
import { commandEnv } from './native-tools.ts';

/**
 * Security tests of the agents (E13.2): no agent reaches keys, secrets, the production network
 * or the git repository of the platform (TECHNICAL §3.1, §6.6, §13, PRD FR-111).
 */

/** What lives in the environment of cms-api, the worker and the runner itself. */
const SECRETS = {
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  ANTHROPIC_AUTH_TOKEN: 'auth-token-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
  OPENAI_API_KEY: 'sk-openai-secret',
  DATABASE_URL: 'postgres://owner:owner-secret@postgres-core/core',
  PGPASSWORD: 'pg-secret',
  SESSION_SECRET: 'session-secret',
  AI_KEYS_MASTER: 'master-secret',
  S3_SECRET_KEY: 's3-secret',
  BUILDER_TOKEN: 'builder-secret',
  REVALIDATE_TOKEN: 'revalidate-secret',
  CMS_AGENT_TOKEN: 'agent-session-token',
  CMS_GIT_ACTOR: 'release',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  GITHUB_TOKEN: 'ghp_secret',
  NPM_TOKEN: 'npm-secret',
} as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [key, value] of Object.entries(SECRETS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of Object.keys(SECRETS)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** Nothing of `SECRETS` may appear in a name or in a value. */
function leaks(env: Record<string, string | undefined>): string[] {
  const values = new Set<string>(Object.values(SECRETS));
  return Object.entries(env)
    .filter(([key, value]) => key in SECRETS || (value !== undefined && values.has(value)))
    .map(([key]) => key);
}

describe('the environment of the processes an agent starts', () => {
  it('does not give shell commands any key, token or secret of the runner', () => {
    expect(leaks(commandEnv())).toEqual([]);
    expect(Object.keys(commandEnv()).sort()).toEqual(
      [
        'CI',
        'COREPACK_ENABLE_DOWNLOAD_PROMPT',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_TERMINAL_PROMPT',
        'HOME',
        'LANG',
        'NO_UPDATE_NOTIFIER',
        'PATH',
      ].sort(),
    );
  });

  it('does not give the Claude Code CLI any API key or platform secret', () => {
    const env = buildClaudeCodeEnv({
      prompt: 'ciao',
      cwd: '/tmp',
      configDir: '/cli-auth/0/claude',
      env: { CMS_API_URL: 'http://cms-api:3100' },
    } as Parameters<typeof buildClaudeCodeEnv>[0]);
    expect(leaks(env)).toEqual([]);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/cli-auth/0/claude');
    // It only ever sees its own login: the credentials of other users are in other folders.
    expect(Object.values(env)).not.toContain('/cli-auth');
  });

  it('strips the API keys even when the caller passes them explicitly', () => {
    const env = buildClaudeCodeEnv({
      prompt: 'ciao',
      cwd: '/tmp',
      configDir: '/cli-auth/0/claude',
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-forced',
        ANTHROPIC_AUTH_TOKEN: 'forced',
        CLAUDE_CODE_OAUTH_TOKEN: 'forced',
      },
    } as Parameters<typeof buildClaudeCodeEnv>[0]);
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
    expect(Object.keys(env)).not.toContain('ANTHROPIC_AUTH_TOKEN');
    expect(Object.keys(env)).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});

describe('a push from the runner to the site repository', () => {
  let dir: string;
  let bare: string;
  let clone: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ai-cms-runner-push-'));
    bare = path.join(dir, 'site.git');
    clone = path.join(dir, 'clone');
    await git(['init', '--bare', '--initial-branch=main', bare], { cwd: dir });
    // The hook the platform installs: the copy in docker/git/hooks is kept in sync by a test.
    const hook = path.join(bare, 'hooks', 'pre-receive');
    await cp(new URL('../../../docker/git/hooks/pre-receive', import.meta.url), hook);
    await chmod(hook, 0o755);
    await git(['clone', bare, clone], { cwd: dir });
    await writeFile(path.join(clone, 'README.md'), 'sito\n');
    await git(['add', '.'], { cwd: clone });
    await git(['commit', '-m', 'iniziale'], { cwd: clone });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['HEAD:refs/heads/main', 'HEAD:refs/heads/staging', 'HEAD:refs/heads/cs/abc'])(
    'is refused for %s, even if the runner process has CMS_GIT_ACTOR set',
    async (refspec) => {
      // The pre-receive hook trusts CMS_GIT_ACTOR, which only the worker sets. The runner's
      // own `git` helper builds a clean environment, so the variable in `process.env` (a
      // mistake in the deployment, or a compromised process) does not reach the push.
      expect(process.env.CMS_GIT_ACTOR).toBe('release');
      const result = await git(['push', 'origin', refspec], { cwd: clone });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('CMS_GIT_ACTOR');
    },
  );

  it('is refused when deleting a branch too', async () => {
    const result = await git(['push', 'origin', ':refs/heads/main'], { cwd: clone });
    expect(result.code).not.toBe(0);
  });
});

/* -------------------------------------------------------------------- docker compose */

interface Service {
  networks?: string[];
  secrets?: string[];
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string> | string[];
}

const compose = parse(
  readFileSync(new URL('../../../docker/compose.yml', import.meta.url), 'utf8'),
  {
    merge: true,
  },
) as {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean } | null>;
  secrets: Record<string, unknown>;
};

const services = Object.entries(compose.services);
const mounts = (service: Service) => (service.volumes ?? []).map((v) => String(v).split(':')[0]!);
const env = (service: Service): Record<string, string> =>
  Array.isArray(service.environment)
    ? Object.fromEntries(
        service.environment.map((entry) => {
          const [key, ...value] = String(entry).split('=');
          return [key!, value.join('=')];
        }),
      )
    : (service.environment ?? {});

describe('the containers of the agents (docker/compose.yml)', () => {
  const runner = compose.services['agent-runner']!;
  const builder = compose.services.builder!;

  it('keeps every service network internal except the one of the egress proxy', () => {
    for (const name of ['control', 'prod', 'staging']) {
      expect(compose.networks[name]?.internal, name).toBe(true);
    }
    // `egress` is the only network with a way out, and only the proxy is on it.
    expect(compose.networks.egress?.internal).toBeUndefined();
    const onEgress = services.filter(([, s]) => s.networks?.includes('egress')).map(([n]) => n);
    expect(onEgress).toEqual(['egress-proxy']);
  });

  it('puts the agent runner on the control network only, with no secret and no port', () => {
    expect(runner.networks).toEqual(['control']);
    expect(runner.secrets ?? []).toEqual([]);
    expect(runner.ports ?? []).toEqual([]);
  });

  it('gives the agent runner no credential in its environment', () => {
    const names = Object.keys(env(runner));
    expect(
      names.filter((name) => /PASSWORD|SECRET|TOKEN|API_KEY|DATABASE_URL|_DB_/i.test(name)),
    ).toEqual([]);
    for (const value of Object.values(env(runner))) {
      expect(value).not.toMatch(/postgres(ql)?:\/\/[^@\s]+:[^@\s]+@/);
    }
  });

  it('mounts in the agent runner only the workspaces and the CLI logins', () => {
    expect(mounts(runner).sort()).toEqual(['cli-auth', 'workspaces']);
  });

  it('keeps the git repositories, the backups and the releases out of the agent runner', () => {
    for (const volume of ['git-repos', 'backups', 'releases', 'pg-core', 'pg-prod', 'artifacts']) {
      expect(mounts(runner), volume).not.toContain(volume);
    }
  });

  it('shares the CLI logins and the site repository with no other service', () => {
    const holding = (volume: string) =>
      services.filter(([, s]) => mounts(s).includes(volume)).map(([name]) => name);
    expect(holding('cli-auth')).toEqual(['agent-runner']);
    expect(holding('git-repos')).toEqual(['worker']);
    expect(holding('backups')).toEqual(['worker']);
  });

  it('keeps the master key of the API keys in cms-api alone', () => {
    const holding = (secret: string) =>
      services.filter(([, s]) => s.secrets?.includes(secret)).map(([name]) => name);
    expect(holding('ai_keys_master')).toEqual(['cms-api']);
    expect(holding('session_secret')).toEqual(['cms-api']);
    // Nobody who runs code written by an agent holds a database owner or admin password.
    for (const name of ['agent-runner', 'builder', 'previews', 'site-prod', 'site-staging']) {
      const held = compose.services[name]!.secrets ?? [];
      expect(
        held.filter((s) => /_(admin|owner)$/.test(s)),
        name,
      ).toEqual([]);
    }
  });

  it('keeps the builder, which runs the code of the agents, out of the production network', () => {
    expect(builder.networks).toEqual(['staging']);
    expect([...(builder.secrets ?? [])].sort()).toEqual(['builder_token', 'pg_core_site_ro']);
    const workspaces = (builder.volumes ?? []).find((v) => String(v).startsWith('workspaces:'));
    expect(String(workspaces)).toMatch(/:ro$/);
  });

  it('sends the outbound traffic of the agent runner and the builder through the proxy', () => {
    for (const service of [runner, builder]) {
      expect(env(service).HTTPS_PROXY).toBe('http://egress-proxy:3128');
    }
  });

  it('publishes no port but the one of the reverse proxy', () => {
    const published = services.filter(([, s]) => (s.ports ?? []).length > 0).map(([name]) => name);
    expect(published).toEqual(['caddy']);
  });

  it('allows the egress proxy to reach the AI providers and the npm registry only', () => {
    const proxy = compose.services['egress-proxy']!;
    const allow = String(env(proxy).EGRESS_ALLOW)
      .replace(/^\$\{EGRESS_ALLOW:-/, '')
      .replace(/\}$/, '');
    const hosts = allow.split(',').map((host) => host.trim());
    expect(hosts.sort()).toEqual(
      ['.anthropic.com', '.claude.ai', '.claude.com', 'registry.npmjs.org'].sort(),
    );
    // No internal name, no address, no wildcard that covers everything.
    for (const host of hosts) {
      expect(host).toMatch(/^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
  });
});
