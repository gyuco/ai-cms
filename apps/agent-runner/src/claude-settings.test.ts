import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildClaudeSettings, prepareClaudeWorkspace, shellQuote } from './claude-settings.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'claude-settings-'));
  await mkdir(path.join(root, '.git', 'info'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildClaudeSettings', () => {
  const settings = buildClaudeSettings({ hookCommand: "'/usr/bin/node' '/app/hook.mjs'" });

  it('allows the command allowlist, edits in the clone and the CMS tools', () => {
    expect(settings.permissions.allow).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Edit(/**)',
      'Bash(pnpm tsc *)',
      'Bash(pnpm test *)',
      'Bash(pnpm lint *)',
      'Bash(pnpm drizzle-kit generate *)',
      'Bash(git status *)',
      'Bash(git diff *)',
      'mcp__cms__*',
    ]);
    expect(settings.permissions.defaultMode).toBe('dontAsk');
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
  });

  it('denies network tools, dependency changes and the protected directories', () => {
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        'WebFetch',
        'Bash(curl *)',
        'Bash(wget *)',
        'Bash(ssh *)',
        'Bash(rm -rf *)',
        'Bash(pnpm add *)',
        'Edit(/.claude/**)',
        'Edit(/.git/**)',
      ]),
    );
  });

  it('allows pnpm add only once the user approved a package', () => {
    const approved = buildClaudeSettings({ hookCommand: 'hook', approvedDependencies: ['zod'] });
    expect(approved.permissions.allow).toContain('Bash(pnpm add *)');
    expect(approved.permissions.deny).not.toContain('Bash(pnpm add *)');
    expect(approved.permissions.deny).toContain('Bash(pnpm install *)');
    expect(settings.permissions.allow).not.toContain('Bash(pnpm add *)');
  });

  it('runs the PreToolUse hook on every tool', () => {
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.hooks).toEqual({
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: "'/usr/bin/node' '/app/hook.mjs'", timeout: 30 }],
        },
      ],
    });
  });
});

describe('prepareClaudeWorkspace', () => {
  it('writes .claude/settings.json and excludes it from git once', async () => {
    await writeFile(path.join(root, '.git', 'info', 'exclude'), '# git ls-files --others\n*.log');
    const file = await prepareClaudeWorkspace(root, { hookCommand: 'hook' });
    await prepareClaudeWorkspace(root, { hookCommand: 'hook' });
    expect(file).toBe(path.join(root, '.claude', 'settings.json'));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(
      buildClaudeSettings({ hookCommand: 'hook' }),
    );
    expect(await readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8')).toBe(
      '# git ls-files --others\n*.log\n/.claude/\n',
    );
  });
});

describe('shellQuote', () => {
  it('quotes for sh', () => {
    expect(shellQuote("/a b/it's")).toBe("'/a b/it'\\''s'");
  });
});
