import type { ChatEngine, ChatEvent, ChatRequest } from '@ai-cms/ai';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentWhoami, CmsClient, ToolUse } from './cms-client.ts';
import { git } from './commit.ts';
import { createRunner, RunError, type RunnerEvent, type RunRequest } from './runner.ts';

const exec = promisify(execFile);

// A fake `claude`: records how it was started, optionally edits a file like the Edit tool
// would, and prints a recorded stream-json turn.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_CLAUDE_DIR;
const mcpIndex = process.argv.indexOf('--mcp-config');
fs.writeFileSync(path.join(dir, 'call.json'), JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  configDir: process.env.CLAUDE_CONFIG_DIR,
  token: process.env.CMS_AGENT_TOKEN ?? null,
  workspace: process.env.CMS_WORKSPACE ?? null,
  apiUrl: process.env.CMS_API_URL ?? null,
  mcp: mcpIndex > 0 ? JSON.parse(fs.readFileSync(process.argv[mcpIndex + 1], 'utf8')) : null,
  settings: fs.existsSync('.claude/settings.json') ? JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8')) : null,
  cwdEntries: fs.readdirSync('.'),
}));
if (process.env.FAKE_EDIT) fs.writeFileSync(process.env.FAKE_EDIT, 'export const x = 1;\\n');
const session = '8f0c5b1e-4a52-4c2e-9d0e-2f1b7f3c9a11';
const lines = [
  { type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5', tools: ['Read'] },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fatto.' } }, parent_tool_use_id: null, session_id: session },
  { type: 'result', subtype: 'success', is_error: false, result: 'Fatto.', stop_reason: 'end_turn', num_turns: 1, session_id: session, usage: { input_tokens: 10, output_tokens: 2 } },
];
process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\\n') + '\\n');
`;

const CHANGESET = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';

let base: string;
let bin: string;
let workspacesRoot: string;
let workspace: string;
let cliAuthRoot: string;
let authorized: ToolUse[];

const dev: AgentWhoami = {
  uid: 7,
  username: 'mario',
  email: 'mario@example.com',
  agent: 'dev-agent',
  env: 'staging',
  changesetId: CHANGESET,
  conversationId: '6d1b1c52-9a0e-4a55-8f7e-1f2e3d4c5b6a',
  expiresAt: '2026-09-26T13:00:00.000Z',
};
const content: AgentWhoami = { ...dev, agent: 'content-agent', env: 'prod', changesetId: null };

const cms: CmsClient = {
  baseUrl: 'http://cms-api:3100',
  async whoami(token) {
    if (token === 'tok-dev') return dev;
    if (token === 'tok-content') return content;
    if (token === 'tok-luigi') return { ...dev, username: 'luigi' };
    return null;
  },
  async authorize(_token, use) {
    authorized.push(use);
    return use.path?.startsWith('data/')
      ? { allowed: false, code: 'agent-profile', message: 'Negato da authz.' }
      : { allowed: true, code: 'ok', message: 'ok' };
  },
};

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'runner-'));
  bin = path.join(base, 'bin');
  workspacesRoot = path.join(base, 'workspaces');
  workspace = path.join(workspacesRoot, CHANGESET);
  cliAuthRoot = path.join(base, 'cli-auth');
  await mkdir(bin);
  await writeFile(path.join(bin, 'claude'), FAKE_CLAUDE);
  await chmod(path.join(bin, 'claude'), 0o755);
  await mkdir(workspace, { recursive: true });
  await exec('git', ['init', '--quiet', '-b', `cs/${CHANGESET}`], { cwd: workspace });
  await writeFile(path.join(workspace, 'README.md'), 'sito\n');
  await git(['add', '-A'], { cwd: workspace });
  await git(['commit', '--quiet', '-m', 'init'], { cwd: workspace });
  await mkdir(path.join(cliAuthRoot, 'mario', 'claude'), { recursive: true });
  await writeFile(path.join(cliAuthRoot, 'mario', 'claude', '.credentials.json'), '{}');
  authorized = [];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function runner(extraEnv: Record<string, string> = {}, engine?: ChatEngine) {
  return createRunner({
    cms,
    workspacesRoot,
    cliAuthRoot,
    hookCommand: "'node' '/app/pre-tool-use.mjs'",
    claudeEnv: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_CLAUDE_DIR: base,
      ...extraEnv,
    },
    ...(engine ? { createEngine: () => engine } : {}),
  });
}

async function run(request: RunRequest, r = runner()) {
  const started = await r.start(request);
  const events: RunnerEvent[] = [];
  const result = await started.execute((e) => events.push(e), new AbortController().signal);
  return { events, result };
}

interface FakeCall {
  args: string[];
  cwd: string;
  configDir: string;
  token: string | null;
  workspace: string | null;
  apiUrl: string | null;
  mcp: unknown;
  settings: { hooks: { PreToolUse: { hooks: { command: string }[] }[] } } | null;
  cwdEntries: string[];
}

async function fakeCall(): Promise<FakeCall> {
  return JSON.parse(await readFile(path.join(base, 'call.json'), 'utf8')) as FakeCall;
}

async function lastCommit() {
  return (await git(['log', '-1', '--format=%an <%ae>%n%B'], { cwd: workspace })).stdout;
}

describe('runner with Claude Code', () => {
  it('runs the developer agent in the clone, restricted, and commits the turn', async () => {
    const { events, result } = await run(
      { token: 'tok-dev', engine: 'claude-code', prompt: 'Aggiungi x\naltri dettagli' },
      runner({ FAKE_EDIT: 'lib.ts' }),
    );
    const call = await fakeCall();
    expect(call.cwd).toBe(await realpath(workspace));
    expect(call.configDir).toBe(path.join(cliAuthRoot, 'mario', 'claude'));
    expect(call).toMatchObject({
      token: 'tok-dev',
      workspace,
      apiUrl: 'http://cms-api:3100',
      mcp: {
        mcpServers: {
          cms: {
            type: 'http',
            url: 'http://cms-api:3100/_cms/internal/mcp',
            headers: { Authorization: 'Bearer tok-dev' },
          },
        },
      },
    });
    const args = call.args;
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Glob,Grep,Bash');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--allowedTools') + 1]).toContain('Bash(pnpm test *)');
    expect(args[args.indexOf('--disallowedTools') + 1]).toContain('Bash(curl *)');
    expect(call.settings?.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(
      "'node' '/app/pre-tool-use.mjs'",
    );

    expect(events.map((e) => e.type)).toEqual([
      'session',
      'text_delta',
      'usage',
      'done',
      'commit',
      'result',
    ]);
    expect(result).toMatchObject({
      type: 'result',
      engine: 'claude-code',
      stopReason: 'end_turn',
      sessionId: '8f0c5b1e-4a52-4c2e-9d0e-2f1b7f3c9a11',
      text: 'Fatto.',
      ai: 'claude-code/claude-opus-5-5',
      commit: { files: ['lib.ts'] },
    });
    expect(await lastCommit()).toBe(
      'mario <mario@example.com>\nAggiungi x\n\nAgent: dev-agent\nAI: claude-code/claude-opus-5-5\n' +
        `Conversation: ${dev.conversationId}\n\n`,
    );
    // The generated settings never reach the changeset.
    const tracked = (await git(['ls-files'], { cwd: workspace })).stdout;
    expect(tracked).not.toContain('.claude');
  });

  it('does not commit when nothing changed', async () => {
    const { events, result } = await run({
      token: 'tok-dev',
      engine: 'claude-code',
      prompt: 'Spiega',
    });
    expect(events.map((e) => e.type)).not.toContain('commit');
    expect(result.commit).toBeUndefined();
    expect(await lastCommit()).toContain('init');
  });

  it('runs the content agent in an empty directory with only the CMS tools', async () => {
    const { result } = await run({
      token: 'tok-content',
      engine: 'claude-code',
      prompt: 'Aggiorna la home',
      resumeSessionId: 'abc-123',
    });
    const call = await fakeCall();
    const args = call.args;
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__cms__*');
    expect(args).toContain('--resume=abc-123');
    expect(call.cwdEntries).toEqual([]);
    expect(call.settings).toBeNull();
    expect(call.token).toBeNull();
    expect(call.cwd).not.toContain(workspacesRoot);
    await expect(stat(call.cwd)).rejects.toThrow();
    expect(result.commit).toBeUndefined();
  });

  it('asks to connect the subscription when the user has no login', async () => {
    await expect(
      runner().start({ token: 'tok-luigi', engine: 'claude-code', prompt: 'x' }),
    ).rejects.toMatchObject({
      status: 412,
      message: 'Collega il tuo abbonamento con make connect-claude-code user=luigi',
    });
  });

  it('reports the subscription status of the token owner, without reading the credentials', async () => {
    const r = runner();
    expect(await r.subscriptionStatus('tok-dev')).toEqual({
      username: 'mario',
      cli: 'claude-code',
      linked: true,
    });
    expect(await r.subscriptionStatus('tok-luigi')).toMatchObject({ linked: false });
    // The file is what counts: an empty one is no login.
    await writeFile(path.join(cliAuthRoot, 'mario', 'claude', '.credentials.json'), '');
    expect(await r.subscriptionStatus('tok-dev')).toMatchObject({ linked: false });
    await expect(r.subscriptionStatus('nope')).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
  });

  it('rejects unknown tokens, missing workspaces and concurrent runs', async () => {
    const r = runner();
    await expect(
      r.start({ token: 'nope', engine: 'claude-code', prompt: 'x' }),
    ).rejects.toBeInstanceOf(RunError);
    await expect(
      r.start({ token: 'tok-content', engine: 'native', prompt: 'x' }),
    ).rejects.toMatchObject({ status: 400 });
    const first = await r.start({ token: 'tok-dev', engine: 'claude-code', prompt: 'x' });
    await expect(
      r.start({ token: 'tok-dev', engine: 'claude-code', prompt: 'y' }),
    ).rejects.toMatchObject({ status: 409, code: 'busy' });
    await first.execute(() => {}, new AbortController().signal);
    expect(r.busy.size).toBe(0);
    await rm(workspace, { recursive: true, force: true });
    await expect(
      r.start({ token: 'tok-dev', engine: 'claude-code', prompt: 'x' }),
    ).rejects.toMatchObject({ status: 409, code: 'no_workspace' });
  });
});

/** A scripted model: each call yields the next list of events. */
function scriptedEngine(steps: ChatEvent[][]) {
  const requests: ChatRequest[] = [];
  const engine: ChatEngine & { connection?: string; model?: string } = {
    provider: 'openai-compatible',
    connection: 'ollama',
    model: 'qwen3',
    capabilities: async () => ({ tools: true, vision: false, streaming: true }),
    async *stream(req) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      yield* steps[requests.length - 1] ?? [{ type: 'done', stopReason: 'end_turn' }];
    },
  };
  return { engine, requests };
}

describe('runner with the native engine', () => {
  it('runs the coding tools through authz and commits the turn', async () => {
    const { engine, requests } = scriptedEngine([
      [
        {
          type: 'tool_call',
          id: 't1',
          name: 'write_file',
          input: { path: 'lib/new.ts', content: 'export {}\n' },
        },
        {
          type: 'tool_call',
          id: 't2',
          name: 'write_file',
          input: { path: 'data/x.ts', content: 'x' },
        },
        { type: 'tool_call', id: 't3', name: 'read_file', input: { path: '../../etc/passwd' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'Creato.' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const { events, result } = await run(
      {
        token: 'tok-dev',
        engine: 'native',
        prompt: 'Crea lib/new.ts',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Ciao' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Ciao!' }] },
        ],
      },
      runner({}, engine),
    );
    expect(requests[0]!.messages).toHaveLength(3);
    expect(requests[0]!.tools.map((t) => t.name)).toEqual([
      'list_files',
      'read_file',
      'write_file',
      'edit_file',
      'search',
      'run',
    ]);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.map((e) => e.type === 'tool_result' && e.isError)).toEqual([false, true, true]);
    expect(authorized).toEqual([
      { tool: 'write_file', path: 'lib/new.ts', exists: false },
      { tool: 'write_file', path: 'data/x.ts', exists: false },
    ]);
    expect(result).toMatchObject({
      engine: 'native',
      stopReason: 'end_turn',
      ai: 'ollama/qwen3',
      commit: { files: ['lib/new.ts'] },
    });
    expect(result.messages).toHaveLength(3);
    expect(await lastCommit()).toContain('AI: ollama/qwen3');
    await expect(stat(path.join(workspace, 'data', 'x.ts'))).rejects.toThrow();
  });
});
