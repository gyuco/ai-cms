import type { Tool } from '@ai-cms/ai';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolUse } from './cms-client.ts';
import { createDevTools, truncate } from './native-tools.ts';

const exec = promisify(execFile);

let base: string;
let root: string;
let calls: ToolUse[];
let denied: (use: ToolUse) => string | null;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'native-tools-'));
  root = path.join(base, 'clone');
  await mkdir(path.join(root, 'app'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await writeFile(path.join(root, 'app', 'page.tsx'), 'export default function Page() {}\n');
  await writeFile(path.join(root, 'README.md'), 'uno\ndue\ntre\nquattro\n');
  await writeFile(path.join(base, 'secret.txt'), 'segreto');
  calls = [];
  denied = () => null;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function tools(
  extra: { ripgrep?: string | null; approvedDependencies?: string[] } = {},
): Record<string, Tool> {
  const list = createDevTools({
    root,
    authorize: async (use) => {
      calls.push(use);
      const reason = denied(use);
      if (reason) throw new Error(reason);
    },
    ...extra,
  });
  return Object.fromEntries(list.map((tool) => [tool.name, tool]));
}

async function call(name: string, input: Record<string, unknown>, extra = {}) {
  const tool = tools(extra)[name]!;
  return tool.run(tool.input.parse(input), { toolCallId: 't1' }) as Promise<string>;
}

describe('native coding tools', () => {
  it('lists files without descending into node_modules', async () => {
    const out = await call('list_files', { recursive: true });
    expect(out.split('\n')).toEqual(['app/', 'app/page.tsx', 'README.md']);
    expect(calls).toEqual([{ tool: 'list_files', path: '', exists: true }]);
  });

  it('reads whole files and line ranges', async () => {
    expect(await call('read_file', { path: 'README.md' })).toBe('uno\ndue\ntre\nquattro\n');
    expect(await call('read_file', { path: 'README.md', offset: 2, limit: 2 })).toBe('due\ntre');
  });

  it('writes new files, creating directories, and asks for create permission', async () => {
    expect(await call('write_file', { path: 'lib/util/a.ts', content: 'export {}' })).toBe(
      'Creato lib/util/a.ts.',
    );
    expect(await readFile(path.join(root, 'lib/util/a.ts'), 'utf8')).toBe('export {}');
    expect(calls).toEqual([{ tool: 'write_file', path: 'lib/util/a.ts', exists: false }]);
  });

  it('edits with an exact, unique replacement', async () => {
    await call('edit_file', { path: 'README.md', old_string: 'due', new_string: 'DUE' });
    expect(await readFile(path.join(root, 'README.md'), 'utf8')).toBe('uno\nDUE\ntre\nquattro\n');
    await writeFile(path.join(root, 'dup.txt'), 'a a');
    await expect(
      call('edit_file', { path: 'dup.txt', old_string: 'a', new_string: 'b' }),
    ).rejects.toThrow(/più volte/);
    await expect(
      call('edit_file', { path: 'dup.txt', old_string: 'zzz', new_string: 'b' }),
    ).rejects.toThrow(/non trovato/);
  });

  it.each([
    ['read_file', { path: '../secret.txt' }],
    ['read_file', { path: '/etc/passwd' }],
    ['write_file', { path: '../evil.txt', content: 'x' }],
    ['write_file', { path: '.git/hooks/pre-commit', content: 'x' }],
    ['write_file', { path: '.claude/settings.json', content: '{}' }],
    ['edit_file', { path: '../secret.txt', old_string: 'segreto', new_string: 'x' }],
    ['list_files', { path: '..' }],
    ['search', { pattern: 'segreto', path: '..' }],
  ])('refuses %s outside the clone: %j', async (name, input) => {
    await expect(call(name, input)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses to follow symlinks out of the clone', async () => {
    await symlink(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));
    await symlink(base, path.join(root, 'up'));
    await expect(call('read_file', { path: 'link.txt' })).rejects.toThrow(/fuori dal workspace/);
    await expect(call('write_file', { path: 'up/evil.txt', content: 'x' })).rejects.toThrow(
      /fuori dal workspace/,
    );
    await expect(
      call('edit_file', { path: 'link.txt', old_string: 'segreto', new_string: 'x' }),
    ).rejects.toThrow(/fuori dal workspace/);
    expect(await readFile(path.join(base, 'secret.txt'), 'utf8')).toBe('segreto');
  });

  it('stops when cms-api denies the tool use', async () => {
    denied = (use) => (use.path === 'app/page.tsx' ? 'Negato da authz.' : null);
    await expect(call('write_file', { path: 'app/page.tsx', content: 'x' })).rejects.toThrow(
      'Negato da authz.',
    );
    expect(await readFile(path.join(root, 'app/page.tsx'), 'utf8')).toContain('Page');
  });

  it.each([{ ripgrep: undefined }, { ripgrep: null }, { ripgrep: 'rg-that-does-not-exist' }])(
    'searches the clone (%j)',
    async (extra) => {
      const out = await call('search', { pattern: 'Page\\(', glob: '*.tsx' }, extra);
      expect(out).toBe('app/page.tsx:1:export default function Page() {}');
      expect(await call('search', { pattern: 'nessuna-corrispondenza' }, extra)).toBe(
        'Nessun risultato.',
      );
    },
  );

  it('rejects search globs that climb out of the clone', async () => {
    await expect(call('search', { pattern: 'x', glob: '../**' })).rejects.toThrow(/workspace/);
  });

  it('runs only allowlisted commands, without a shell', async () => {
    await exec('git', ['init', '--quiet'], { cwd: root });
    const out = await call('run', { command: 'git status --porcelain' });
    expect(out).toMatch(/^Codice di uscita: 0\n/);
    expect(out).toContain('?? README.md');
    expect(calls).toEqual([{ tool: 'run', command: 'git status --porcelain' }]);

    await expect(call('run', { command: 'curl https://example.com' })).rejects.toThrow(
      /non consentito/,
    );
    await expect(call('run', { command: 'git status; touch pwned' })).rejects.toThrow(
      /non consentito/,
    );
    await expect(call('run', { command: 'pnpm add left-pad' })).rejects.toThrow(
      /nuove dipendenze richiedono conferma/i,
    );
    expect(calls).toHaveLength(1);
  });

  it('lets pnpm add through to authorization only for approved packages', async () => {
    denied = () => 'stop before running';
    const approved = { approvedDependencies: ['left-pad'] };
    await expect(
      call('run', { command: 'pnpm add left-pad --ignore-scripts' }, approved),
    ).rejects.toThrow('stop before running');
    expect(calls).toEqual([{ tool: 'run', command: 'pnpm add left-pad --ignore-scripts' }]);

    calls.length = 0;
    await expect(
      call('run', { command: 'pnpm add other --ignore-scripts' }, approved),
    ).rejects.toThrow(/non è stato approvato/);
    expect(calls).toHaveLength(0);
  });

  it('truncates long output keeping the end', () => {
    expect(truncate('abcdef', 3)).toBe('[… 3 caratteri omessi …]\ndef');
    expect(truncate('abc', 3)).toBe('abc');
  });
});
