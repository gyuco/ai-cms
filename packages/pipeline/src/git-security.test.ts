import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGit } from './git.ts';
import { installPreReceiveHook } from './pre-receive.ts';

/**
 * Unauthorized pushes to the site repository (E13.2, TECHNICAL §6.6). An agent has no
 * `CMS_GIT_ACTOR` and can pick any name for a branch or a tag: the hook has to refuse whatever
 * the worker did not push, including refs that only look like the allowed ones.
 */
describe('pushes to site.git that the worker did not make', () => {
  let dir: string;
  let bare: string;
  let clone: string;

  const push = (actor: string | null, ...refspecs: string[]) =>
    runGit(['push', '--porcelain', '--force', 'origin', ...refspecs], {
      cwd: clone,
      env: actor === null ? {} : { CMS_GIT_ACTOR: actor },
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-git-security-'));
    bare = join(dir, 'site.git');
    clone = join(dir, 'clone');
    await runGit(['init', '--bare', '--initial-branch=main', bare]);
    await installPreReceiveHook(bare);
    await runGit(['clone', bare, clone]);
    await writeFile(join(clone, 'README.md'), 'sito\n');
    await runGit(['add', '.'], { cwd: clone });
    await runGit(['commit', '-m', 'iniziale'], { cwd: clone });
    // The worker publishes the first release.
    await push('release', 'HEAD:refs/heads/main', 'HEAD:refs/heads/staging');
    await runGit(['tag', 'release-1'], { cwd: clone });
    await push('release', 'refs/tags/release-1');
    await writeFile(join(clone, 'evil.txt'), 'malware\n');
    await runGit(['add', '.'], { cwd: clone });
    await runGit(['commit', '-m', 'agente'], { cwd: clone });
    await runGit(['tag', 'release-2'], { cwd: clone });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const head = (ref: string) => runGit(['rev-parse', ref], { cwd: bare });

  it.each([
    ['nobody', null],
    ['an agent that names itself', 'agent'],
    ['an agent that claims to be the developer agent', 'dev-agent'],
    ['a capitalized actor', 'Release'],
    ['an actor with padding', 'release '],
    ['an empty actor', ''],
  ])('are refused for %s, forced or not', async (_label, actor) => {
    const before = await head('main');
    for (const refspec of [
      'HEAD:refs/heads/main',
      'HEAD:refs/heads/staging',
      'HEAD:refs/heads/cs/abc',
      'refs/tags/release-2',
      'HEAD:refs/heads/anything',
      'HEAD:refs/notes/commits',
      ':refs/heads/main',
      ':refs/tags/release-1',
    ]) {
      await expect(push(actor, refspec), refspec).rejects.toThrow(/rifiutato/);
    }
    expect(await head('main')).toBe(before);
  });

  it('do not let a changeset touch the branches and tags of the releases', async () => {
    for (const refspec of [
      'HEAD:refs/heads/main',
      'HEAD:refs/heads/staging',
      'refs/tags/release-2',
      // Look-alikes of `cs/*`.
      'HEAD:refs/heads/csx',
      'HEAD:refs/heads/cs',
      'HEAD:refs/heads/x/cs/abc',
      'HEAD:refs/notes/cs/abc',
    ]) {
      await expect(push('changeset', refspec), refspec).rejects.toThrow(/rifiutato/);
    }
  });

  it('do not let a release touch the branches of the changesets or look-alike tags', async () => {
    await runGit(['tag', 'v1'], { cwd: clone });
    await runGit(['tag', 'release'], { cwd: clone });
    for (const refspec of [
      'HEAD:refs/heads/cs/abc',
      'HEAD:refs/heads/main-evil',
      'HEAD:refs/heads/mainx',
      'HEAD:refs/heads/x/main',
      'refs/tags/release',
      'refs/tags/v1',
    ]) {
      await expect(push('release', refspec), refspec).rejects.toThrow(/rifiutato/);
    }
    expect(await head('main')).not.toBe(await runGit(['rev-parse', 'HEAD'], { cwd: clone }));
  });

  it('keep main and the release tags where the worker put them', async () => {
    const branches = await runGit(['branch', '--list', '--format=%(refname)'], { cwd: bare });
    expect(branches.split('\n').filter(Boolean).sort()).toEqual([
      'refs/heads/main',
      'refs/heads/staging',
    ]);
    const tags = await runGit(['tag', '--list'], { cwd: bare });
    expect(tags.trim()).toBe('release-1');
  });
});
