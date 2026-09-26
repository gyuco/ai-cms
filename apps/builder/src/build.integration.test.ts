import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuilderCheckName, CheckStatus, PreviewConfig } from '@ai-cms/pipeline/builder';
import { afterAll, describe, expect, it } from 'vitest';
import { executeRun } from './run.ts';

const platformRoot = fileURLToPath(new URL('../../..', import.meta.url));

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@localhost',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@localhost',
    },
  }).trim();
}

/**
 * Builds a changeset for real with the current site template: a copy of this monorepo, an
 * offline pnpm install from the local store, tsc and next build (about 30 s). Needs the
 * workspace to be installed (`pnpm install`); skipped with SKIP_BUILD_TESTS=1.
 */
describe.skipIf(process.env.SKIP_BUILD_TESTS === '1')('builder integration', () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('checks and builds the site template as a changeset', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-build-'));
    const changesetId = randomUUID();
    const clone = join(dir, 'workspaces', changesetId);
    const skipped = new Set([
      'node_modules',
      '.next',
      '.turbo',
      'tsconfig.tsbuildinfo',
      'next-env.d.ts',
    ]);
    await cp(join(platformRoot, 'templates', 'site'), clone, {
      recursive: true,
      filter: (source) => !skipped.has(basename(source)),
    });
    git(clone, 'init', '--quiet', '-b', 'main');
    git(clone, 'add', '--all');
    git(clone, 'commit', '--quiet', '-m', 'sito');
    const commit = git(clone, 'rev-parse', 'HEAD');

    const storeDir = execFileSync('pnpm', ['store', 'path'], { encoding: 'utf8' })
      .trim()
      .replace(/\/v\d+$/, '');
    process.env.PNPM_STORE_DIR ??= storeDir;

    // Published content for the built site: a seeded core database, when one is available.
    let content: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
    if (testDatabaseUrl) {
      content = await createTestDatabase();
      await seed(content.db, { hashPassword: async (p) => p });
    }

    const results = new Map<BuilderCheckName, { status: CheckStatus; output: string | null }>();
    const artifactsRoot = join(dir, 'artifacts');
    await executeRun(
      {
        changesetId,
        commit,
        databaseUrl: 'postgres://site_app:x@127.0.0.1:1/app_cs_test',
        checks: ['deps', 'typecheck', 'lint', 'build', 'e2e', 'html'],
        pages: ['/'],
        publishedPages: ['/'],
      },
      {
        platformRoot,
        workRoot: join(dir, 'work'),
        workspacesRoot: join(dir, 'workspaces'),
        artifactsRoot,
        contentDatabaseUrl: content?.url,
      },
      (name, status, output = null) => results.set(name, { status, output }),
    );

    await content?.drop();
    const summary = Object.fromEntries([...results].map(([k, v]) => [k, v.status]));
    const outputs = [...results]
      .map(([k, v]) => `## ${k}: ${v.status}\n${v.output ?? ''}`)
      .join('\n');
    const required = content
      ? (['deps', 'typecheck', 'lint', 'build', 'e2e'] as const)
      : (['deps', 'typecheck', 'build'] as const);
    for (const check of required) {
      expect(summary[check], outputs).toBe('passed');
    }
    // lint and html depend on the template content (owned elsewhere): they only have to finish.
    expect(['passed', 'failed']).toContain(summary.lint);
    expect(['passed', 'failed']).toContain(summary.html);

    const preview = JSON.parse(
      await readFile(join(artifactsRoot, changesetId, 'preview.json'), 'utf8'),
    ) as PreviewConfig;
    expect(preview).toMatchObject({
      changesetId,
      commit,
      artifact: commit,
      server: 'templates/site/server.js',
      env: { DATABASE_URL: 'postgres://site_app:x@127.0.0.1:1/app_cs_test', CMS_ENV: 'staging' },
    });
    await access(join(artifactsRoot, changesetId, commit, 'templates/site/server.js'));
    await access(join(artifactsRoot, changesetId, commit, 'templates/site/.next/static'));
    // The private workspace of the run is gone.
    await expect(access(join(dir, 'work'))).resolves.toBeUndefined();
    expect(execFileSync('ls', ['-A', join(dir, 'work')], { encoding: 'utf8' })).toBe('');
  }, 300_000);
});
