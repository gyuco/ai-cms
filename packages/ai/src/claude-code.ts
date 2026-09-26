import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentEvent, AgentStopReason } from './agent.ts';
import type { StopReason, Usage } from './types.ts';

/**
 * CLI engine for Claude Code subscriptions (TECHNICAL §7.4): runs the official, unmodified
 * `claude` binary in print mode with the user's own login (`CLAUDE_CONFIG_DIR`) and turns its
 * `stream-json` output into the same events as the native agent loop.
 *
 * The stream-json shapes used here follow the Agent SDK message types (`SDKMessage` in
 * `@anthropic-ai/claude-agent-sdk`, matching Claude Code 2.1.283): `system/init`,
 * `system/api_retry`, `stream_event`, `assistant`, `user`, `rate_limit_event`, `result`.
 */

/** An HTTP MCP server entry of `--mcp-config` (`{ "mcpServers": { name: … } }`). */
export interface ClaudeCodeMcpServer {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface ClaudeCodeMcpConfig {
  mcpServers: Record<string, ClaudeCodeMcpServer>;
}

export type ClaudeCodePermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

export interface ClaudeCodeOptions {
  prompt: string;
  /** Working directory of the CLI, e.g. the changeset worktree. */
  cwd: string;
  /** The user's CLI profile (`claudeCodeConfigDir`), never shared between users (FR-125). */
  configDir: string;
  /** Written to a private temporary file, since it carries the MCP session token. */
  mcpConfig?: ClaudeCodeMcpConfig;
  /** Session to continue, from a previous `session` event. */
  resumeSessionId?: string;
  /** Permission rules that run without asking (`--allowedTools`). */
  allowedTools?: string[];
  /** Deny rules; a bare tool name removes the tool (`--disallowedTools`). */
  disallowedTools?: string[];
  /** Built-in tools available at all (`--tools`); `[]` disables every built-in tool. */
  tools?: string[];
  permissionMode?: ClaudeCodePermissionMode;
  model?: string;
  maxTurns?: number;
  appendSystemPrompt?: string;
  signal?: AbortSignal;
  /**
   * Extra environment for the CLI. The child does not inherit the caller's environment: only
   * PATH, HOME, locale, temp dir and proxy variables are passed through.
   */
  env?: Record<string, string>;
  /** Executable name or path; default `claude`, looked up in PATH. */
  executable?: string;
}

export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: Date;
  /** e.g. `five_hour`, `seven_day`. */
  rateLimitType?: string;
}

export type ClaudeCodeEvent =
  | AgentEvent
  | { type: 'session'; sessionId: string; model?: string; tools?: string[] }
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; error: string }
  | ({ type: 'rate_limit' } & RateLimitInfo);

export interface ClaudeCodeResult {
  /** Pass it back as `resumeSessionId` to continue the conversation. */
  sessionId?: string;
  stopReason: AgentStopReason;
  /** Final answer text reported by the CLI. */
  text: string;
  usage: Required<Usage>;
  /** Estimated cost reported by the CLI; with a subscription it is not billed per call. */
  costUsd?: number;
  numTurns?: number;
  detail?: string;
  rateLimited?: boolean;
  resetsAt?: Date;
}

const PASSTHROUGH_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

// With a subscription the CLI must use the user's login, never an API key (TECHNICAL §7.4).
const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

const KILL_GRACE_MS = 5000;
const STDERR_LIMIT = 4000;

// Fallback when the CLI reports the limit only as text, e.g. in stderr or the result.
const LIMIT_TEXT = /usage limit|rate limit|hit your limit|limit reached/i;

export function buildClaudeCodeArgs(options: ClaudeCodeOptions, mcpConfigPath?: string): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
  if (options.resumeSessionId) args.push(`--resume=${options.resumeSessionId}`);
  if (options.allowedTools?.length) args.push('--allowedTools', options.allowedTools.join(','));
  if (options.disallowedTools?.length) {
    args.push('--disallowedTools', options.disallowedTools.join(','));
  }
  if (options.tools) args.push('--tools', options.tools.join(','));
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.model) args.push('--model', options.model);
  if (options.maxTurns !== undefined) args.push('--max-turns', String(options.maxTurns));
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  // After `--` the prompt is never parsed as an option, even when it starts with a dash.
  args.push('--', options.prompt);
  return args;
}

export function buildClaudeCodeEnv(options: ClaudeCodeOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, options.env);
  for (const key of STRIPPED_ENV) delete env[key];
  env.CLAUDE_CONFIG_DIR = options.configDir;
  return env;
}

/** `resetsAt` is a Unix timestamp; seconds are assumed unless the value only makes sense as ms. */
function toDate(timestamp: unknown): Date | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      return isObject(block) ? `[${String(block.type)}]` : '';
    })
    .join('\n');
}

function toUsage(raw: unknown): Required<Usage> {
  const u = isObject(raw) ? raw : {};
  const n = (key: string) => (typeof u[key] === 'number' ? u[key] : 0);
  const cacheRead = n('cache_read_input_tokens');
  const cacheWrite = n('cache_creation_input_tokens');
  return {
    inputTokens: n('input_tokens') + cacheRead + cacheWrite,
    outputTokens: n('output_tokens'),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

function mapStopReason(reason: unknown): StopReason & AgentStopReason {
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'refusal') return 'refusal';
  return 'end_turn';
}

function formatReset(date: Date): string {
  return date.toLocaleString('it-IT', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: process.env.TZ || 'Europe/Rome',
  });
}

export function rateLimitMessage(resetsAt?: Date): string {
  const base = "Limite di utilizzo dell'abbonamento Claude raggiunto.";
  return resetsAt ? `${base} Il limite si ripristina il ${formatReset(resetsAt)}.` : base;
}

const RESULT_ERRORS: Record<string, string> = {
  error_max_turns: 'Raggiunto il numero massimo di turni.',
  error_max_budget_usd: 'Raggiunto il budget massimo della richiesta.',
  error_during_execution: "Errore durante l'esecuzione di Claude Code.",
};

const RETRYABLE_ERRORS = new Set(['rate_limit', 'overloaded', 'server_error']);

/**
 * Runs one Claude Code turn and yields its events. The generator's return value is the
 * summary of the run. Like the chat adapters it never throws for CLI failures: they end the
 * stream with an `error` event followed by `done { stopReason: 'error' }`.
 */
export async function* streamClaudeCode(
  options: ClaudeCodeOptions,
): AsyncGenerator<ClaudeCodeEvent, ClaudeCodeResult> {
  const usage: Required<Usage> = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const summary: ClaudeCodeResult = { stopReason: 'error', text: '', usage };
  const { signal } = options;

  if (signal?.aborted) {
    yield { type: 'error', message: 'Richiesta interrotta.', aborted: true };
    yield { type: 'done', stopReason: 'error', detail: 'aborted' };
    return { ...summary, stopReason: 'aborted' };
  }

  let tempDir: string | undefined;
  let mcpConfigPath: string | undefined;
  if (options.mcpConfig) {
    tempDir = await mkdtemp(path.join(tmpdir(), 'cms-claude-'));
    mcpConfigPath = path.join(tempDir, 'mcp.json');
    await writeFile(mcpConfigPath, JSON.stringify(options.mcpConfig), { mode: 0o600 });
  }

  const child = spawn(options.executable ?? 'claude', buildClaudeCodeArgs(options, mcpConfigPath), {
    cwd: options.cwd,
    // Cast: Next.js augments ProcessEnv with a required NODE_ENV.
    env: buildClaudeCodeEnv(options) as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  let spawnError: NodeJS.ErrnoException | undefined;
  const exited = new Promise<{ code: number | null }>((resolve) => {
    child.once('error', (err) => {
      spawnError = err;
      resolve({ code: null });
    });
    child.once('close', (code) => resolve({ code }));
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_LIMIT);
  });

  let killTimer: NodeJS.Timeout | undefined;
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    killTimer.unref();
  };
  child.once('close', () => clearTimeout(killTimer));
  signal?.addEventListener('abort', kill, { once: true });

  const toolNames = new Map<string, string>();
  let result: Json | undefined;
  let assistantError: string | undefined;
  let rejected: RateLimitInfo | undefined;

  try {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // Not a stream-json line (e.g. a warning): ignore it.
      }
      if (!isObject(msg)) continue;
      // Subagent traffic is internal to the CLI: the chat shows only the main conversation.
      if (msg.parent_tool_use_id !== undefined && msg.parent_tool_use_id !== null) continue;

      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
            summary.sessionId = msg.session_id;
            yield {
              type: 'session',
              sessionId: msg.session_id,
              ...(typeof msg.model === 'string' ? { model: msg.model } : {}),
              ...(Array.isArray(msg.tools) ? { tools: msg.tools as string[] } : {}),
            };
          } else if (msg.subtype === 'api_retry') {
            yield {
              type: 'retry',
              attempt: Number(msg.attempt ?? 0),
              maxRetries: Number(msg.max_retries ?? 0),
              delayMs: Number(msg.retry_delay_ms ?? 0),
              error: String(msg.error ?? 'unknown'),
            };
          }
          break;

        case 'stream_event': {
          const event = msg.event;
          if (
            isObject(event) &&
            event.type === 'content_block_delta' &&
            isObject(event.delta) &&
            event.delta.type === 'text_delta' &&
            typeof event.delta.text === 'string'
          ) {
            yield { type: 'text_delta', text: event.delta.text };
          }
          break;
        }

        case 'assistant': {
          if (typeof msg.error === 'string') assistantError = msg.error;
          const message = msg.message;
          if (!isObject(message) || !Array.isArray(message.content)) break;
          // Text already arrived as stream events: only tool calls are taken from here.
          for (const block of message.content) {
            if (!isObject(block) || block.type !== 'tool_use') continue;
            const id = String(block.id);
            const name = String(block.name);
            toolNames.set(id, name);
            yield { type: 'tool_call', id, name, input: block.input };
          }
          break;
        }

        case 'user': {
          const message = msg.message;
          if (!isObject(message) || !Array.isArray(message.content)) break;
          for (const block of message.content) {
            if (!isObject(block) || block.type !== 'tool_result') continue;
            const toolCallId = String(block.tool_use_id);
            yield {
              type: 'tool_result',
              toolCallId,
              name: toolNames.get(toolCallId) ?? '',
              content: toolResultText(block.content),
              isError: block.is_error === true,
            };
          }
          break;
        }

        case 'rate_limit_event': {
          const info = msg.rate_limit_info;
          if (!isObject(info)) break;
          const resetsAt = toDate(info.resetsAt);
          const event: RateLimitInfo = {
            status: info.status as RateLimitInfo['status'],
            ...(resetsAt ? { resetsAt } : {}),
            ...(typeof info.rateLimitType === 'string'
              ? { rateLimitType: info.rateLimitType }
              : {}),
          };
          if (event.status === 'rejected') rejected = event;
          yield { type: 'rate_limit', ...event };
          break;
        }

        case 'result':
          result = msg;
          break;
      }
    }
    const { code } = await exited;

    if (signal?.aborted) {
      yield { type: 'error', message: 'Richiesta interrotta.', aborted: true };
      yield { type: 'done', stopReason: 'error', detail: 'aborted' };
      return { ...summary, stopReason: 'aborted' };
    }

    if (result) {
      Object.assign(usage, toUsage(result.usage));
      if (typeof result.total_cost_usd === 'number') summary.costUsd = result.total_cost_usd;
      if (typeof result.num_turns === 'number') summary.numTurns = result.num_turns;
      if (typeof result.result === 'string') summary.text = result.result;
      if (typeof result.session_id === 'string') summary.sessionId = result.session_id;
      yield { type: 'usage', ...usage };

      if (result.subtype === 'success' && result.is_error !== true) {
        const stopReason = mapStopReason(result.stop_reason);
        yield { type: 'done', stopReason };
        return { ...summary, stopReason };
      }
    }

    // Failure: work out whether it is the plan limit.
    const status =
      typeof result?.api_error_status === 'number' ? result.api_error_status : undefined;
    const errors = Array.isArray(result?.errors) ? (result.errors as unknown[]).map(String) : [];
    const reported =
      (result?.subtype === 'success' ? summary.text : '') ||
      errors.join('\n') ||
      (typeof result?.subtype === 'string' ? (RESULT_ERRORS[result.subtype] ?? '') : '');
    const rateLimited =
      rejected !== undefined ||
      assistantError === 'rate_limit' ||
      status === 429 ||
      LIMIT_TEXT.test(reported) ||
      (!result && LIMIT_TEXT.test(stderr));

    let message: string;
    if (rateLimited) {
      message = rateLimitMessage(rejected?.resetsAt);
    } else if (spawnError) {
      message =
        spawnError.code === 'ENOENT'
          ? 'Claude Code non è installato: comando claude non trovato.'
          : `Impossibile avviare Claude Code: ${spawnError.message}`;
    } else if (reported) {
      message = reported;
    } else {
      const tail = stderr.trim().split('\n').slice(-5).join('\n');
      message = `Claude Code è terminato con codice ${code ?? 'sconosciuto'}${tail ? `: ${tail}` : '.'}`;
    }

    const retryable =
      rateLimited ||
      (assistantError !== undefined && RETRYABLE_ERRORS.has(assistantError)) ||
      (status !== undefined && status >= 500);
    const stopReason: AgentStopReason =
      result?.subtype === 'error_max_turns' ? 'max_steps' : 'error';
    yield {
      type: 'error',
      message,
      ...(status !== undefined ? { status } : {}),
      ...(retryable ? { retryable: true } : {}),
      ...(rateLimited ? { rateLimited: true } : {}),
      ...(rateLimited && rejected?.resetsAt ? { resetsAt: rejected.resetsAt } : {}),
    };
    yield { type: 'done', stopReason: 'error', detail: message };
    return {
      ...summary,
      stopReason,
      detail: message,
      ...(rateLimited ? { rateLimited: true } : {}),
      ...(rateLimited && rejected?.resetsAt ? { resetsAt: rejected.resetsAt } : {}),
    };
  } finally {
    signal?.removeEventListener('abort', kill);
    // Also reached when the consumer stops iterating early.
    kill();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

export interface RunClaudeCodeOptions extends ClaudeCodeOptions {
  onEvent?: (event: ClaudeCodeEvent) => void;
}

/** Runs one Claude Code turn, forwarding events to `onEvent`, and returns the summary. */
export async function runClaudeCode(options: RunClaudeCodeOptions): Promise<ClaudeCodeResult> {
  const stream = streamClaudeCode(options);
  for (;;) {
    const next = await stream.next();
    if (next.done) return next.value;
    options.onEvent?.(next.value);
  }
}
