import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuilderRunRequest, CheckStatus } from '@ai-cms/pipeline/builder';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult } from './exec.ts';
import { dependencyChanges, executeRun, hasTests, type RunTools } from './run.ts';

const request: BuilderRunRequest = {
  changesetId: '0b5c7a4e-9d1f-4c3a-8e2b-1f2a3b4c5d6e',
  commit: 'a'.repeat(40),
  databaseUrl: 'postgres://site_app:pw@postgres-staging:5432/app_cs_x',
  checks: ['typecheck', 'lint', 'deps', 'unit', 'build', 'e2e', 'html', 'a11y'],
  pages: ['/', '/prenota'],
  publishedPages: ['/'],
};

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

interface Fake {
  tools: RunTools;
  commands: string[];
  envs: Array<Record<string, string>>;
  results: Map<string, { status: CheckStatus; output: string | null }>;
  report: (name: string, status: CheckStatus, output?: string | null) => void;
  stopped: () => boolean;
}

/** Tools that record what would run; `fail` makes the named command fail. */
async function fake(
  options: { fail?: string[]; tests?: boolean; sitePackage?: object } = {},
): Promise<Fake> {
  const dir = await mkdtemp(join(tmpdir(), 'ai-cms-run-'));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  const site = join(repo, 'templates', 'site');
  await mkdir(join(site, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(site, 'node_modules', '.bin', 'next'), '');
  await writeFile(join(site, 'package.json'), JSON.stringify(options.sitePackage ?? {}));
  if (options.tests) await writeFile(join(site, 'prezzi.test.ts'), '');
  const commands: string[] = [];
  const envs: Array<Record<string, string>> = [];
  const results = new Map<string, { status: CheckStatus; output: string | null }>();
  let stopped = false;
  const exec = async (
    command: string,
    args: readonly string[],
    opts: { env: Record<string, string> },
  ) => {
    const line = `${command.split('/').pop()!} ${args.join(' ')}`;
    commands.push(line);
    envs.push(opts.env);
    const failing = options.fail?.some((f) => line.startsWith(f));
    const output =
      failing && line.startsWith('pnpm') ? 'ERR_PNPM_OUTDATED_LOCKFILE' : `out ${line}`;
    return { code: failing ? 1 : 0, output, timedOut: false } satisfies CommandResult;
  };
  const tools: RunTools = {
    exec,
    prepare: async () => ({ dir: join(dir, 'ws'), repo, site, home: join(dir, 'home') }),
    lint: async () => ({ status: 'passed', output: 'lint ok' }),
    saveArtifact: async () => ({
      dir: 'x',
      server: '/art/server.js',
      preview: {} as never,
    }),
    startSite: async () => ({
      url: 'http://127.0.0.1:1',
      logs: () => '',
      stop: async () => {
        stopped = true;
      },
    }),
    smokeTest: async () => ({ status: 'passed', output: 'smoke ok' }),
    validatePages: async (_base, paths) => ({ status: 'passed', output: paths.join(',') }),
  };
  return {
    tools,
    commands,
    envs,
    results,
    report: (name, status, output = null) => results.set(name, { status, output }),
    stopped: () => stopped,
  };
}

const config = {
  platformRoot: '/nonexistent',
  workRoot: '/tmp',
  workspacesRoot: '/data/workspaces',
  artifactsRoot: '/data/artifacts',
};

const statuses = (f: Fake) => Object.fromEntries([...f.results].map(([k, v]) => [k, v.status]));

describe('executeRun', () => {
  it('runs every check in order and passes a clean site', async () => {
    const f = await fake();
    await executeRun(request, config, f.report, f.tools);
    expect(statuses(f)).toEqual({
      deps: 'passed',
      typecheck: 'passed',
      lint: 'passed',
      unit: 'skipped',
      build: 'passed',
      e2e: 'passed',
      html: 'passed',
      a11y: 'skipped',
    });
    expect(f.commands).toEqual([
      'pnpm install --frozen-lockfile --offline --ignore-scripts --reporter=append-only --filter ./templates/site... --filter .',
      'next typegen',
      'tsc --noEmit -p .',
      'next build',
    ]);
    expect(f.results.get('html')?.output).toBe('/,/prenota');
    expect(f.results.get('a11y')?.output).toMatch(/axe-core/);
    expect(f.stopped()).toBe(true);
  });

  it('never hands platform variables to site commands', async () => {
    process.env.BUILDER_TOKEN = 'segreto';
    try {
      const f = await fake();
      await executeRun(request, config, f.report, f.tools);
      for (const env of f.envs) {
        expect(Object.values(env)).not.toContain('segreto');
        expect(Object.keys(env)).not.toContain('BUILDER_TOKEN');
      }
      expect(f.envs.at(-1)).toMatchObject({
        DATABASE_URL: request.databaseUrl,
        CMS_ENV: 'staging',
      });
    } finally {
      delete process.env.BUILDER_TOKEN;
    }
  });

  it('explains new dependencies and skips what needs them', async () => {
    const f = await fake({
      fail: ['pnpm'],
      sitePackage: { dependencies: { next: '^16', 'left-pad': '^1.3.0' } },
    });
    await executeRun(request, config, f.report, f.tools);
    expect(statuses(f)).toMatchObject({
      deps: 'failed',
      typecheck: 'skipped',
      lint: 'passed',
      unit: 'skipped',
      build: 'skipped',
      e2e: 'skipped',
      html: 'skipped',
    });
    expect(f.results.get('deps')?.output).toMatch(
      /left-pad@\^1\.3\.0 \(nuova\)[\s\S]*approvazione/,
    );
  });

  it('reports a failed build and skips the checks that need the artifact', async () => {
    const f = await fake({ fail: ['next build', 'tsc'], tests: true });
    await executeRun(request, config, f.report, f.tools);
    expect(statuses(f)).toMatchObject({
      typecheck: 'failed',
      unit: 'passed',
      build: 'failed',
      e2e: 'skipped',
      html: 'skipped',
    });
    expect(f.commands).toContain('vitest run --root .');
    expect(f.results.get('typecheck')?.output).toContain('out tsc --noEmit');
  });

  it('runs only the requested checks', async () => {
    const f = await fake();
    await executeRun({ ...request, checks: ['lint'] }, config, f.report, f.tools);
    expect(statuses(f)).toEqual({ lint: 'passed' });
    expect(f.commands).toHaveLength(1); // the install always runs
  });

  it('fails every check when the changeset cannot be prepared', async () => {
    const f = await fake();
    f.tools.prepare = async () => {
      throw new Error('commit inesistente');
    };
    await executeRun(request, config, f.report, f.tools);
    expect(new Set(Object.values(statuses(f)))).toEqual(new Set(['failed']));
    expect(f.results.get('build')?.output).toMatch(/commit inesistente/);
  });

  it('fails e2e and html when the site does not start', async () => {
    const f = await fake();
    f.tools.startSite = async () => {
      throw new Error('porta occupata');
    };
    await executeRun(request, config, f.report, f.tools);
    expect(f.results.get('e2e')).toEqual({
      status: 'failed',
      output: expect.stringMatching(/porta occupata/),
    });
    expect(f.results.get('html')?.status).toBe('failed');
  });
});

describe('dependencyChanges', () => {
  it('lists added, changed and removed dependencies', () => {
    expect(
      dependencyChanges(
        { dependencies: { next: '^16', react: '^19' }, devDependencies: { vitest: '^5' } },
        { dependencies: { next: '^17', react: '^19', zod: '^4' } },
      ),
    ).toEqual(['+ zod@^4 (nuova)', '- vitest (rimossa)', '~ next: ^16 → ^17']);
    expect(dependencyChanges(null, {})).toEqual([]);
  });
});

describe('hasTests', () => {
  it('finds test files outside node_modules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-cms-tests-'));
    dirs.push(dir);
    await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'x', 'a.test.ts'), '');
    expect(await hasTests(dir)).toBe(false);
    await mkdir(join(dir, 'tests'));
    await writeFile(join(dir, 'tests', 'prezzi.spec.tsx'), '');
    expect(await hasTests(dir)).toBe(true);
  });
});
