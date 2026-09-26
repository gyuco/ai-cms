import { describe, expect, it } from 'vitest';
import { checkCommand, splitCommand } from './commands.ts';

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
  it.each([
    'pnpm tsc --noEmit',
    'pnpm test',
    'pnpm test -- src/lib/a.test.ts',
    'pnpm lint',
    'pnpm drizzle-kit generate',
    'git status',
    'git status --porcelain',
    'git diff --stat HEAD',
  ])('allows %s', (command) => {
    expect(checkCommand(command)).toMatchObject({ allowed: true });
  });

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
    ['pnpm test -C /tmp', 'forbidden-argument'],
    ['pnpm test --dir=../x', 'forbidden-argument'],
    ['pnpm lint --config.foo=bar', 'forbidden-argument'],
  ])('denies %s (%s)', (command, code) => {
    expect(checkCommand(command)).toMatchObject({ allowed: false, code });
  });

  it('explains that new dependencies need a confirmation', () => {
    const check = checkCommand('pnpm add left-pad');
    expect(!check.allowed && check.message).toMatch(/nuove dipendenze richiedono conferma/i);
  });
});
