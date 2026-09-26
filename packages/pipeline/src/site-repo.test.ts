import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGit } from './git.ts';
import { bareRepoPath, initSiteRepo, siteRepoPaths } from './site-repo.ts';

describe('siteRepoPaths', () => {
  it('defaults to the worker volumes', () => {
    expect(siteRepoPaths({})).toEqual({
      gitRoot: '/data/git',
      workspacesRoot: '/data/workspaces',
    });
    expect(siteRepoPaths({ GIT_ROOT: '/g', WORKSPACES_ROOT: '/w' })).toEqual({
      gitRoot: '/g',
      workspacesRoot: '/w',
    });
  });
});

describe('initSiteRepo', () => {
  let dir: string;
  let templateDir: string;
  let gitRoot: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-site-'));
    templateDir = join(dir, 'template');
    gitRoot = join(dir, 'data', 'git');
    await mkdir(join(templateDir, 'app'), { recursive: true });
    await mkdir(join(templateDir, 'node_modules', 'next'), { recursive: true });
    await mkdir(join(templateDir, '.next'), { recursive: true });
    await writeFile(join(templateDir, 'package.json'), '{"name":"site"}\n');
    await writeFile(join(templateDir, 'app', 'page.tsx'), 'export default () => null;\n');
    await writeFile(join(templateDir, 'node_modules', 'next', 'index.js'), '');
    await writeFile(join(templateDir, '.next', 'build'), '');
    await writeFile(join(templateDir, 'tsconfig.tsbuildinfo'), '{}');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('imports the template on main and staging', async () => {
    const result = await initSiteRepo({ gitRoot, templateDir });
    expect(result.created).toBe(true);
    expect(result.staging).toBe(result.main);

    const bare = bareRepoPath(gitRoot);
    const files = await runGit(['ls-tree', '-r', '--name-only', 'main'], { cwd: bare });
    expect(files.split('\n').filter(Boolean).sort()).toEqual([
      '.gitignore',
      'app/page.tsx',
      'package.json',
    ]);
    const author = await runGit(['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main'], {
      cwd: bare,
    });
    expect(author.trim()).toBe('AI-CMS <system@localhost>|AI-CMS <system@localhost>');
    expect((await stat(join(bare, 'hooks', 'pre-receive'))).mode & 0o111).toBe(0o111);
  });

  it('is idempotent', async () => {
    const first = await runGit(['rev-parse', 'main'], { cwd: bareRepoPath(gitRoot) });
    const again = await initSiteRepo({ gitRoot, templateDir });
    expect(again.created).toBe(false);
    expect(again.main).toBe(first.trim());
    expect(again.staging).toBe(first.trim());
  });

  it('recreates a missing staging branch from main', async () => {
    const bare = bareRepoPath(gitRoot);
    await runGit(['update-ref', '-d', 'refs/heads/staging'], { cwd: bare });
    const result = await initSiteRepo({ gitRoot, templateDir });
    expect(result.staging).toBe(result.main);
  });
});
