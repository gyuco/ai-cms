import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClaudeCodeArgs,
  runClaudeCode,
  streamClaudeCode,
  type ClaudeCodeEvent,
  type ClaudeCodeOptions,
} from './claude-code.ts';

// A fake `claude` executable: records how it was called and replays recorded stream-json lines.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_CLAUDE_DIR;
process.on('SIGTERM', () => { fs.writeFileSync(path.join(dir, 'killed'), ''); process.exit(143); });
const mcpIndex = process.argv.indexOf('--mcp-config');
const mcpFile = mcpIndex > 0 ? process.argv[mcpIndex + 1] : null;
fs.writeFileSync(path.join(dir, 'call.json'), JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  configDir: process.env.CLAUDE_CONFIG_DIR,
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
  secret: process.env.CMS_SECRET ?? null,
  mcp: mcpFile ? JSON.parse(fs.readFileSync(mcpFile, 'utf8')) : null,
  mcpMode: mcpFile ? (fs.statSync(mcpFile).mode & 0o777).toString(8) : null,
}));
const lines = fs.readFileSync(path.join(dir, 'lines.jsonl'), 'utf8');
process.stdout.write(lines);
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
if (process.env.FAKE_HANG) {
  setInterval(() => {}, 1000);
} else {
  process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
}
`;

const SESSION = '8f0c5b1e-4a52-4c2e-9d0e-2f1b7f3c9a11';
const base = { uuid: 'u', session_id: SESSION };

const init = {
  type: 'system',
  subtype: 'init',
  cwd: '/workspaces/cs-1',
  tools: ['mcp__cms__whoami'],
  mcp_servers: [{ name: 'cms', status: 'connected' }],
  model: 'claude-opus-5-5',
  permissionMode: 'default',
  apiKeySource: 'none',
  ...base,
};

const textDelta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  parent_tool_use_id: null,
  ...base,
});

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { id: 'msg_1', role: 'assistant', content, usage: { input_tokens: 1 } },
  parent_tool_use_id: null,
  ...extra,
  ...base,
});

const successResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1200,
  duration_api_ms: 1000,
  num_turns: 2,
  result: 'Sei mario.',
  stop_reason: 'end_turn',
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 50,
  },
  modelUsage: {},
  permission_denials: [],
  ...base,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  await writeFile(path.join(dir, 'claude'), FAKE_CLAUDE);
  await chmod(path.join(dir, 'claude'), 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function script(lines: unknown[]) {
  await writeFile(
    path.join(dir, 'lines.jsonl'),
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
  );
}

function options(extra: Partial<ClaudeCodeOptions> = {}, env: Record<string, string> = {}) {
  return {
    prompt: 'Chi sono?',
    cwd: dir,
    configDir: '/cli-auth/mario/claude',
    ...extra,
    env: {
      // The fake binary is found through the PATH given to the child.
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_CLAUDE_DIR: dir,
      ...env,
    },
  } satisfies ClaudeCodeOptions;
}

async function collect(opts: ClaudeCodeOptions) {
  const events: ClaudeCodeEvent[] = [];
  const result = await runClaudeCode({ ...opts, onEvent: (e) => events.push(e) });
  return { events, result };
}

async function call() {
  return JSON.parse(await readFile(path.join(dir, 'call.json'), 'utf8')) as Record<string, unknown>;
}

describe('runClaudeCode', () => {
  it('converts a turn with a tool call into chat events', async () => {
    await script([
      init,
      textDelta('Controllo '),
      textDelta('chi sei.'),
      assistant([{ type: 'text', text: 'Controllo chi sei.' }]),
      assistant([{ type: 'tool_use', id: 'toolu_1', name: 'mcp__cms__whoami', input: {} }]),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: '{"username":"mario"}' }],
            },
          ],
        },
        parent_tool_use_id: null,
        ...base,
      },
      // Subagent traffic is not forwarded.
      { ...textDelta('interno'), parent_tool_use_id: 'toolu_9' },
      'not json',
      textDelta('Sei mario.'),
      successResult,
    ]);
    const { events, result } = await collect(options());
    expect(events).toEqual([
      {
        type: 'session',
        sessionId: SESSION,
        model: 'claude-opus-5-5',
        tools: ['mcp__cms__whoami'],
      },
      { type: 'text_delta', text: 'Controllo ' },
      { type: 'text_delta', text: 'chi sei.' },
      { type: 'tool_call', id: 'toolu_1', name: 'mcp__cms__whoami', input: {} },
      {
        type: 'tool_result',
        toolCallId: 'toolu_1',
        name: 'mcp__cms__whoami',
        content: '{"username":"mario"}',
        isError: false,
      },
      { type: 'text_delta', text: 'Sei mario.' },
      {
        type: 'usage',
        inputTokens: 450,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheWriteTokens: 50,
      },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    expect(result).toMatchObject({
      sessionId: SESSION,
      stopReason: 'end_turn',
      text: 'Sei mario.',
      costUsd: 0.0123,
      numTurns: 2,
    });
  });

  it('passes the options as CLI flags, the MCP config as a private file and a clean env', async () => {
    await script([init, successResult]);
    process.env.CMS_SECRET = 'do-not-leak';
    try {
      await collect(
        options(
          {
            prompt: '--help è un prompt, non un flag',
            resumeSessionId: SESSION,
            allowedTools: ['mcp__cms__whoami', 'Bash(git diff *)'],
            disallowedTools: ['WebFetch'],
            tools: [],
            permissionMode: 'dontAsk',
            mcpConfig: {
              mcpServers: {
                cms: {
                  type: 'http',
                  url: 'http://cms-api:3100/_cms/internal/mcp',
                  headers: { Authorization: 'Bearer tok' },
                },
              },
            },
          },
          { ANTHROPIC_API_KEY: 'sk-should-be-removed' },
        ),
      );
    } finally {
      delete process.env.CMS_SECRET;
    }
    const recorded = await call();
    const args = recorded.args as string[];
    const mcpPath = args[args.indexOf('--mcp-config') + 1];
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--mcp-config',
      mcpPath,
      '--strict-mcp-config',
      `--resume=${SESSION}`,
      '--allowedTools',
      'mcp__cms__whoami,Bash(git diff *)',
      '--disallowedTools',
      'WebFetch',
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--',
      '--help è un prompt, non un flag',
    ]);
    expect(recorded).toMatchObject({
      configDir: '/cli-auth/mario/claude',
      apiKey: null,
      secret: null,
      mcpMode: '600',
      mcp: { mcpServers: { cms: { type: 'http', headers: { Authorization: 'Bearer tok' } } } },
    });
    // The temporary MCP config (it holds the session token) is removed afterwards.
    await expect(readFile(mcpPath!)).rejects.toThrow();
  });

  it('reports the plan limit as a retryable, rate-limited error with the reset time', async () => {
    const resetsAt = 1_790_000_000;
    await script([
      init,
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' },
        ...base,
      },
      assistant([{ type: 'text', text: "You've hit your limit" }], { error: 'rate_limit' }),
      {
        ...successResult,
        is_error: true,
        result: "You've hit your limit",
        api_error_status: 429,
      },
    ]);
    const { events, result } = await collect(options({}, { FAKE_EXIT: '1' }));
    expect(events).toContainEqual({
      type: 'rate_limit',
      status: 'rejected',
      resetsAt: new Date(resetsAt * 1000),
      rateLimitType: 'five_hour',
    });
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({
      type: 'error',
      status: 429,
      retryable: true,
      rateLimited: true,
      resetsAt: new Date(resetsAt * 1000),
    });
    expect(error && 'message' in error && error.message).toMatch(
      /^Limite di utilizzo dell'abbonamento Claude raggiunto\. Il limite si ripristina il /,
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'error' });
    expect(result).toMatchObject({ stopReason: 'error', rateLimited: true, sessionId: SESSION });
  });

  it('recognises the plan limit from the text alone', async () => {
    await script([
      init,
      { ...successResult, is_error: true, result: 'Claude AI usage limit reached' },
    ]);
    const { result } = await collect(options());
    expect(result).toMatchObject({ rateLimited: true, stopReason: 'error' });
  });

  it('reports other failures with their message', async () => {
    await script([
      init,
      {
        ...successResult,
        subtype: 'error_max_turns',
        is_error: true,
        errors: [],
        result: undefined,
      },
    ]);
    const { events, result } = await collect(options());
    expect(events.find((e) => e.type === 'error')).toEqual({
      type: 'error',
      message: 'Raggiunto il numero massimo di turni.',
    });
    expect(result.stopReason).toBe('max_steps');
  });

  it('reports a crash without a result, with the end of stderr', async () => {
    await script([init]);
    const { events } = await collect(
      options({}, { FAKE_EXIT: '2', FAKE_STDERR: 'Error: something broke\n' }),
    );
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: 'Claude Code è terminato con codice 2: Error: something broke',
    });
  });

  it('reports a missing executable', async () => {
    await script([]);
    const { events } = await collect(options({ executable: 'claude-missing' }));
    expect(events).toEqual([
      { type: 'error', message: 'Claude Code non è installato: comando claude non trovato.' },
      {
        type: 'done',
        stopReason: 'error',
        detail: 'Claude Code non è installato: comando claude non trovato.',
      },
    ]);
  });

  it('terminates the child process when the signal aborts', async () => {
    await script([init, textDelta('Sto lavorando…')]);
    const controller = new AbortController();
    const events: ClaudeCodeEvent[] = [];
    const result = await runClaudeCode({
      ...options({ signal: controller.signal }, { FAKE_HANG: '1' }),
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'text_delta') controller.abort();
      },
    });
    expect(result.stopReason).toBe('aborted');
    expect(result.sessionId).toBe(SESSION);
    expect(events.at(-2)).toMatchObject({ type: 'error', aborted: true });
    await expect(readFile(path.join(dir, 'killed'))).resolves.toBeDefined();
  });

  it('kills the process when the consumer stops iterating', async () => {
    await script([init]);
    const stream = streamClaudeCode(options({}, { FAKE_HANG: '1' }));
    const first = await stream.next();
    expect(first.value).toMatchObject({ type: 'session' });
    await stream.return(undefined as never);
    await expect
      .poll(() =>
        readFile(path.join(dir, 'killed')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
  });

  it('does not start when already aborted', async () => {
    const { result } = await collect(options({ signal: AbortSignal.abort() }));
    expect(result.stopReason).toBe('aborted');
    await expect(call()).rejects.toThrow();
  });
});

describe('buildClaudeCodeArgs', () => {
  it('keeps the prompt last, after the end of options', () => {
    const args = buildClaudeCodeArgs({ prompt: 'ciao', cwd: '/', configDir: '/c', maxTurns: 3 });
    expect(args.slice(-4)).toEqual(['--max-turns', '3', '--', 'ciao']);
  });
});
