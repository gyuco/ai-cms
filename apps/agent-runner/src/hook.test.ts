import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ToolUse } from './cms-client.ts';
import { decidePreToolUse, runPreToolUseHook, type HookEnv } from './hook.ts';

let base: string;
let root: string;
let calls: ToolUse[];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'hook-'));
  root = path.join(base, 'clone');
  await mkdir(path.join(root, 'app'), { recursive: true });
  await writeFile(path.join(root, 'app', 'page.tsx'), 'x');
  calls = [];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function env(deny: (use: ToolUse) => string | null = () => null): HookEnv {
  return {
    workspace: root,
    authorize: async (use) => {
      calls.push(use);
      const reason = deny(use);
      return reason
        ? { allowed: false, code: 'denied', message: reason }
        : { allowed: true, code: 'ok', message: 'ok' };
    },
  };
}

// Shaped like the PreToolUse input documented at code.claude.com/docs/en/hooks.
function input(tool: string, toolInput: Record<string, unknown>) {
  return {
    session_id: 'abc123',
    transcript_path: '/cli-auth/mario/claude/projects/x/transcript.jsonl',
    cwd: root,
    permission_mode: 'dontAsk',
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: 'toolu_01ABC123',
  };
}

describe('decidePreToolUse', () => {
  it('checks files with cms-api, relative to the clone', async () => {
    expect(
      await decidePreToolUse(input('Read', { file_path: path.join(root, 'app/page.tsx') }), env()),
    ).toEqual({ allow: true });
    expect(
      await decidePreToolUse(
        input('Write', { file_path: path.join(root, 'lib/new.ts'), content: 'x' }),
        env(),
      ),
    ).toEqual({ allow: true });
    expect(
      await decidePreToolUse(
        input('Edit', {
          file_path: path.join(root, 'app/page.tsx'),
          old_string: 'x',
          new_string: 'y',
          replace_all: false,
        }),
        env(),
      ),
    ).toEqual({ allow: true });
    expect(await decidePreToolUse(input('Glob', { pattern: '**/*.tsx' }), env())).toEqual({
      allow: true,
    });
    expect(
      await decidePreToolUse(
        input('Grep', { pattern: 'TODO', path: path.join(root, 'app') }),
        env(),
      ),
    ).toEqual({ allow: true });
    expect(calls).toEqual([
      { tool: 'Read', path: 'app/page.tsx', exists: true },
      { tool: 'Write', path: 'lib/new.ts', exists: false },
      { tool: 'Edit', path: 'app/page.tsx', exists: true },
      { tool: 'Glob', path: '', exists: true },
      { tool: 'Grep', path: 'app', exists: true },
    ]);
  });

  it('checks commands with cms-api', async () => {
    const verdict = await decidePreToolUse(
      input('Bash', { command: 'pnpm add left-pad', description: 'Add', timeout: 120000 }),
      env(() => 'Le nuove dipendenze richiedono conferma.'),
    );
    expect(verdict).toEqual({ allow: false, reason: 'Le nuove dipendenze richiedono conferma.' });
    expect(calls).toEqual([{ tool: 'Bash', command: 'pnpm add left-pad' }]);
  });

  it('denies paths outside the clone without asking cms-api', async () => {
    await symlink(base, path.join(root, 'up'));
    for (const toolInput of [
      { file_path: '/etc/passwd' },
      { file_path: path.join(root, '..', 'x') },
      { file_path: path.join(root, 'up', 'x') },
      { file_path: path.join(root, '.claude', 'settings.json') },
    ]) {
      const verdict = await decidePreToolUse(input('Read', toolInput), env());
      expect(verdict.allow).toBe(false);
    }
    expect(await decidePreToolUse(input('Glob', { pattern: '../../**' }), env())).toMatchObject({
      allow: false,
    });
    expect(
      await decidePreToolUse(input('Grep', { pattern: 'x', glob: '/etc/*' }), env()),
    ).toMatchObject({ allow: false });
    expect(calls).toEqual([]);
  });

  it('lets CMS MCP tools through and denies any other tool', async () => {
    expect(await decidePreToolUse(input('mcp__cms__read_node', { path: '/site' }), env())).toEqual({
      allow: true,
    });
    for (const tool of ['WebFetch', 'Agent', 'NotebookEdit', 'mcp__other__x']) {
      expect(await decidePreToolUse(input(tool, {}), env())).toMatchObject({ allow: false });
    }
    expect(
      await decidePreToolUse(
        input('Bash', { command: 'pnpm test', run_in_background: true }),
        env(),
      ),
    ).toMatchObject({ allow: false });
    expect(calls).toEqual([]);
  });
});

describe('runPreToolUseHook', () => {
  it('exits 0 with no output to allow', async () => {
    const out = await runPreToolUseHook(
      JSON.stringify(input('Bash', { command: 'git status' })),
      () => env(),
    );
    expect(out).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('prints a deny decision and exits 2', async () => {
    const out = await runPreToolUseHook(JSON.stringify(input('Bash', { command: 'curl x' })), () =>
      env(() => 'Comando non consentito: curl.'),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe('Comando non consentito: curl.');
    expect(JSON.parse(out.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Comando non consentito: curl.',
      },
    });
  });

  it('fails closed on bad input or unreachable cms-api', async () => {
    expect((await runPreToolUseHook('not json', () => env())).exitCode).toBe(2);
    const out = await runPreToolUseHook(
      JSON.stringify(input('Bash', { command: 'git status' })),
      () => ({
        workspace: root,
        authorize: async () => {
          throw new Error('fetch failed');
        },
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toMatch(/Impossibile verificare i permessi: fetch failed/);
    expect(
      (
        await runPreToolUseHook('{}', () => {
          throw new Error('configurazione del hook incompleta');
        })
      ).exitCode,
    ).toBe(2);
  });
});

describe('hook entry point', () => {
  let server: Server;
  let url: string;
  const received: unknown[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { command?: string };
        received.push({ url: req.url, ...parsed });
        const allowed = parsed.command === 'git status';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ allowed, code: 'x', message: allowed ? 'ok' : 'Negato.' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function runMain(stdin: string, extraEnv: Record<string, string>) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        ['--import', 'tsx', path.join(import.meta.dirname, 'hook-main.ts')],
        { env: { PATH: process.env.PATH ?? '', ...extraEnv }, cwd: import.meta.dirname },
        (error, stdout, stderr) => {
          resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
        },
      );
      child.stdin!.end(stdin);
    });
  }

  it('reads stdin, asks cms-api and answers with the exit code', async () => {
    const hookEnv = { CMS_API_URL: url, CMS_AGENT_TOKEN: 'tok', CMS_WORKSPACE: root };
    const ok = await runMain(JSON.stringify(input('Bash', { command: 'git status' })), hookEnv);
    expect(ok).toEqual({ code: 0, stdout: '', stderr: '' });
    const no = await runMain(JSON.stringify(input('Bash', { command: 'git diff' })), hookEnv);
    expect(no.code).toBe(2);
    expect(no.stderr).toBe('Negato.');
    expect(received[0]).toEqual({
      url: '/_cms/internal/agent/authorize',
      token: 'tok',
      tool: 'Bash',
      command: 'git status',
    });
    const missing = await runMain(JSON.stringify(input('Bash', { command: 'git status' })), {});
    expect(missing.code).toBe(2);
  }, 20_000);
});
