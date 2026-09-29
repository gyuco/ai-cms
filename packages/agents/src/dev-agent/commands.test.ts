import { describe, expect, it } from 'vitest';
import { checkCommand, describeAllowedCommands, splitCommand } from './commands.ts';

describe('splitCommand', () => {
  it('splits words and quoted strings', () => {
    expect(splitCommand('pnpm test -- "src/a b.test.ts"')).toEqual([
      'pnpm',
      'test',
      '--',
      'src/a b.test.ts',
    ]);
    expect(splitCommand("git  diff 'app/page.tsx'")).toEqual(['git', 'diff', 'app/page.tsx']);
  });

  it.each([
    'pnpm test && curl http://x',
    'pnpm test; rm -rf /',
    'pnpm test | sh',
    'git diff > out.txt',
    'pnpm test $(whoami)',
    'pnpm test `id`',
    'pnpm test "$HOME"',
    'pnpm test *.ts',
    'pnpm test\nrm -rf /',
    'pnpm test "unterminated',
    'pnpm test \\x',
  ])('rejects shell syntax: %s', (command) => {
    expect(splitCommand(command)).toBeNull();
  });
});

describe('checkCommand', () => {
  it.each(['git status', 'git status --porcelain', 'git diff --stat HEAD'])(
    'allows %s',
    (command) => {
      expect(checkCommand(command)).toMatchObject({ allowed: true });
    },
  );

  it.each([
    ['curl https://example.com', 'not-allowed'],
    ['wget https://example.com', 'not-allowed'],
    ['ssh host', 'not-allowed'],
    ['rm -rf /', 'not-allowed'],
    ['git push origin main', 'not-allowed'],
    ['git -c core.pager=sh status', 'not-allowed'],
    ['FOO=1 pnpm test', 'not-allowed'],
    ['pnpm run build', 'not-allowed'],
    ['pnpm exec node x.js', 'not-allowed'],
    ['pnpm dlx cowsay', 'not-allowed'],
    ['pnpm install', 'not-allowed'],
    ['pnpm test && curl x', 'unparsable'],
    ['', 'unparsable'],
    ['pnpm add left-pad', 'dependency-add'],
    ['pnpm add -D vitest', 'dependency-add'],
    ['pnpm install zod', 'dependency-add'],
    ['pnpm i zod', 'dependency-add'],
    ['npm install zod', 'dependency-add'],
    ['git diff --output=/tmp/x', 'forbidden-argument'],
    ['git diff --ext-diff', 'forbidden-argument'],
    ['git diff /etc/passwd', 'forbidden-argument'],
    ['git diff ../other', 'forbidden-argument'],
    ['git status -C /tmp', 'forbidden-argument'],
    ['git diff --dir=../x', 'forbidden-argument'],
  ])('denies %s (%s)', (command, code) => {
    expect(checkCommand(command)).toMatchObject({ allowed: false, code });
  });

  // The site's code never runs next to the subscription logins (E13.4).
  it.each([
    'pnpm tsc --noEmit',
    'pnpm test',
    'pnpm test -- src/lib/a.test.ts',
    'pnpm lint',
    'pnpm drizzle-kit generate',
    'pnpm run build',
    'pnpm exec vitest',
    'node scripts/x.mjs',
    'npx tsx x.ts',
    'tsc --noEmit',
    'sh script.sh',
  ])('denies %s: it would run the code of the site', (command) => {
    const check = checkCommand(command);
    expect(check).toMatchObject({ allowed: false });
    expect(!check.allowed && check.message).toMatch(/builder/);
  });

  it('allows only read-only git commands without a dependency approval', () => {
    expect(describeAllowedCommands()).toBe('git status, git diff');
  });

  it('requires both --ignore-scripts and --ignore-pnpmfile on pnpm add', () => {
    const approved = { approvedDependencies: ['left-pad'] };
    for (const command of [
      'pnpm add left-pad',
      'pnpm add left-pad --ignore-scripts',
      'pnpm add left-pad --ignore-pnpmfile',
    ]) {
      expect(checkCommand(command, approved)).toMatchObject({
        allowed: false,
        code: 'dependency-add',
      });
    }
  });

  it('explains that new dependencies need a confirmation', () => {
    const check = checkCommand('pnpm add left-pad');
    expect(!check.allowed && check.message).toMatch(/nuove dipendenze richiedono conferma/i);
  });

  describe('with approved dependencies', () => {
    const approved = { approvedDependencies: ['left-pad', '@scope/pkg'] };

    it.each([
      'pnpm add left-pad --ignore-scripts --ignore-pnpmfile',
      'pnpm add -D left-pad@1.3.0 --ignore-scripts --ignore-pnpmfile',
      'pnpm add @scope/pkg@^2 left-pad --save-exact --ignore-scripts --ignore-pnpmfile',
    ])('allows %s', (command) => {
      expect(checkCommand(command, approved)).toMatchObject({ allowed: true });
    });

    it.each([
      ['pnpm add left-pad', 'dependency-add'],
      ['pnpm add other --ignore-scripts --ignore-pnpmfile', 'dependency-add'],
      ['pnpm add --ignore-scripts --ignore-pnpmfile', 'dependency-add'],
      ['pnpm install left-pad --ignore-scripts --ignore-pnpmfile', 'dependency-add'],
      ['npm i left-pad', 'dependency-add'],
      ['pnpm add left-pad@github:evil/x --ignore-scripts --ignore-pnpmfile', 'forbidden-argument'],
      [
        'pnpm add left-pad@https://x.io/a.tgz --ignore-scripts --ignore-pnpmfile',
        'forbidden-argument',
      ],
      ['pnpm add ./local --ignore-scripts --ignore-pnpmfile', 'forbidden-argument'],
      ['pnpm add left-pad --ignore-scripts --ignore-pnpmfile --global', 'forbidden-argument'],
      ['pnpm add left-pad --ignore-scripts --ignore-pnpmfile --dir=/tmp', 'forbidden-argument'],
    ])('denies %s (%s)', (command, code) => {
      expect(checkCommand(command, approved)).toMatchObject({ allowed: false, code });
    });

    it('still asks for the approval when none was given', () => {
      expect(
        checkCommand('pnpm add left-pad --ignore-scripts --ignore-pnpmfile', {}),
      ).toMatchObject({
        allowed: false,
        code: 'dependency-add',
      });
    });
  });
});
