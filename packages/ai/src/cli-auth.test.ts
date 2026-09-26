import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeConfigDir, hasClaudeCodeLogin } from './cli-auth.ts';

const run = promisify(execFile);
const SCRIPT = path.resolve(import.meta.dirname, '../../../docker/images/cms-connect');

let root: string;
let bin: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cli-auth-'));
  bin = await mkdtemp(path.join(tmpdir(), 'cli-bin-'));
  // Fake interactive `claude`: records where it was started and with which profile.
  await writeFile(
    path.join(bin, 'claude'),
    `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$CLAUDE_CONFIG_DIR" "$PWD" "\${ANTHROPIC_API_KEY:-none}" > "$FAKE_OUT"\n`,
  );
  await chmod(path.join(bin, 'claude'), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
});

function connect(...args: string[]) {
  return run('sh', [SCRIPT, ...args], {
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      CLI_AUTH_ROOT: root,
      FAKE_OUT: path.join(bin, 'out'),
      ANTHROPIC_API_KEY: 'sk-must-not-reach-the-cli',
    },
  }).then(
    ({ stdout }) => ({ code: 0, stdout, stderr: '' }),
    (err: { code: number; stdout: string; stderr: string }) => err,
  );
}

describe('claudeCodeConfigDir', () => {
  it('builds the per-user profile path', () => {
    expect(claudeCodeConfigDir('/cli-auth', 'mario.rossi')).toBe('/cli-auth/mario.rossi/claude');
  });

  it('rejects names that could leave the root', () => {
    for (const name of ['..', '../root', 'a/b', '.hidden', '', 'x', 'a b', 'a\nb']) {
      expect(() => claudeCodeConfigDir('/cli-auth', name)).toThrow(/Invalid username/);
    }
  });
});

describe('hasClaudeCodeLogin', () => {
  it('checks only for a non-empty credentials file', async () => {
    const dir = claudeCodeConfigDir(root, 'mario');
    expect(await hasClaudeCodeLogin(dir)).toBe(false);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '.credentials.json'), '');
    expect(await hasClaudeCodeLogin(dir)).toBe(false);
    await writeFile(path.join(dir, '.credentials.json'), '{}');
    expect(await hasClaudeCodeLogin(dir)).toBe(true);
  });
});

describe('cms-connect', () => {
  it('creates a private profile and opens the CLI with it', async () => {
    const result = await connect('claude-code', '--user', 'mario');
    expect(result.code).toBe(0);
    const dir = claudeCodeConfigDir(root, 'mario');
    const [configDir, cwd, apiKey] = (await readFile(path.join(bin, 'out'), 'utf8')).split('\n');
    expect(configDir).toBe(dir);
    expect(cwd).toBe(dir);
    expect(apiKey).toBe('none');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.dirname(dir))).mode & 0o777).toBe(0o700);
  });

  it('reports the login status consistently with hasClaudeCodeLogin', async () => {
    const missing = await connect('claude-code', '--user', 'mario', '--status');
    expect(missing).toMatchObject({ code: 1 });
    expect(missing.stdout).toContain('nessun abbonamento collegato per mario');

    const dir = claudeCodeConfigDir(root, 'mario');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '.credentials.json'), '{}');
    const linked = await connect('claude-code', '--user=mario', '--status');
    expect(linked).toMatchObject({ code: 0 });
    expect(linked.stdout).toContain('abbonamento collegato per mario');
    expect(await hasClaudeCodeLogin(dir)).toBe(true);
  });

  it('rejects unsafe usernames and unknown CLIs', async () => {
    for (const name of ['..', '../x', 'a/b', '-rf', 'a b', 'a\nb']) {
      const result = await connect('claude-code', '--user', name);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Nome utente non valido');
    }
    expect(await connect('codex', '--user', 'mario')).toMatchObject({ code: 2 });
    expect(await connect('claude-code')).toMatchObject({ code: 2 });
  });
});
