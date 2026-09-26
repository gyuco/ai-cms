import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGit } from './git.ts';
import { installPreReceiveHook, PRE_RECEIVE_HOOK } from './pre-receive.ts';

describe('pre-receive hook', () => {
  let dir: string;
  let bare: string;
  let clone: string;

  const push = (actor: string | null, ...refspecs: string[]) =>
    runGit(['push', '--porcelain', 'origin', ...refspecs], {
      cwd: clone,
      env: actor === null ? {} : { CMS_GIT_ACTOR: actor },
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-hook-'));
    bare = join(dir, 'site.git');
    clone = join(dir, 'clone');
    await runGit(['init', '--bare', '--initial-branch=main', bare]);
    await installPreReceiveHook(bare);
    await runGit(['clone', bare, clone]);
    await writeFile(join(clone, 'README.md'), 'hello\n');
    await runGit(['add', '.'], { cwd: clone });
    await runGit(['commit', '-m', 'initial'], { cwd: clone });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is installed executable and matches the copy in docker/git/hooks', async () => {
    const mode = (await stat(join(bare, 'hooks', 'pre-receive'))).mode;
    expect(mode & 0o111).toBe(0o111);
    const copy = await readFile(
      new URL('../../../docker/git/hooks/pre-receive', import.meta.url),
      'utf8',
    );
    expect(copy).toBe(PRE_RECEIVE_HOOK);
  });

  it('refuses pushes without an actor', async () => {
    await expect(push(null, 'HEAD:refs/heads/main')).rejects.toThrow(/CMS_GIT_ACTOR/);
    await expect(push('agent', 'HEAD:refs/heads/cs/x')).rejects.toThrow(/CMS_GIT_ACTOR/);
  });

  it('lets releases update main, staging and release tags only', async () => {
    await push('release', 'HEAD:refs/heads/main', 'HEAD:refs/heads/staging');
    await runGit(['tag', 'release-1'], { cwd: clone });
    await push('release', 'refs/tags/release-1');
    await expect(push('release', 'HEAD:refs/heads/cs/abc')).rejects.toThrow(/solo main, staging/);
    await runGit(['tag', 'v1'], { cwd: clone });
    await expect(push('release', 'refs/tags/v1')).rejects.toThrow(/rifiutato/);
    await expect(push('release', ':refs/heads/staging')).rejects.toThrow(/eliminare/);
  });

  it('lets changesets update cs/* branches only, without deleting them', async () => {
    await writeFile(join(clone, 'page.tsx'), 'export default 1;\n');
    await runGit(['add', '.'], { cwd: clone });
    await runGit(['commit', '-m', 'work'], { cwd: clone });
    await push('changeset', 'HEAD:refs/heads/cs/abc');
    await expect(push('changeset', 'HEAD:refs/heads/main')).rejects.toThrow(/solo i rami cs/);
    await expect(push('changeset', 'HEAD:refs/heads/staging')).rejects.toThrow(/rifiutato/);
    await expect(push('changeset', 'refs/tags/release-1:refs/tags/release-2')).rejects.toThrow(
      /rifiutato/,
    );
    await expect(push('changeset', ':refs/heads/cs/abc')).rejects.toThrow(/eliminare/);
    const branches = await runGit(['branch', '--list', '--format=%(refname)'], { cwd: bare });
    expect(branches.split('\n').filter(Boolean).sort()).toEqual([
      'refs/heads/cs/abc',
      'refs/heads/main',
      'refs/heads/staging',
    ]);
  });

  it('refuses the whole push when one ref is not allowed', async () => {
    await writeFile(join(clone, 'README.md'), 'changed\n');
    await runGit(['commit', '-am', 'change'], { cwd: clone });
    await expect(
      push('changeset', 'HEAD:refs/heads/cs/abc', 'HEAD:refs/heads/main'),
    ).rejects.toThrow(/rifiutato/);
    const [csHead, localHead] = await Promise.all([
      runGit(['rev-parse', 'refs/heads/cs/abc'], { cwd: bare }),
      runGit(['rev-parse', 'HEAD'], { cwd: clone }),
    ]);
    expect(csHead).not.toBe(localHead);
  });
});
