import {
  claudeCodeConfigDir,
  hasClaudeCodeLogin,
  runAgent,
  streamClaudeCode,
  type AgentStopReason,
  type ChatEngine,
  type ChatMessage,
  type ClaudeCodeEvent,
  type ClaudeCodeOptions,
  type ClaudeCodeResult,
  type Usage,
} from '@ai-cms/ai';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentWhoami, CmsClient } from './cms-client.ts';
import {
  DEV_AGENT_CLI_TOOLS,
  devAgentAllowRules,
  devAgentDenyRules,
  MCP_SERVER_NAME,
  prepareClaudeWorkspace,
} from './claude-settings.ts';
import { commitTurn, type CommitResult } from './commit.ts';
import { GatewayChatEngine } from './gateway-engine.ts';
import { createDevTools } from './native-tools.ts';

export type EngineKind = 'claude-code' | 'native';

export interface RunRequest {
  /** Agent session token issued by cms-api or the worker (`issueAgentSession`). */
  token: string;
  engine: EngineKind;
  prompt: string;
  /** Claude Code session to continue. */
  resumeSessionId?: string;
  /** Native engine: the conversation so far, without the new prompt. */
  messages?: ChatMessage[];
}

export interface RunResultEvent {
  type: 'result';
  engine: EngineKind;
  agent: AgentWhoami['agent'];
  stopReason: AgentStopReason;
  /** Claude Code session, to pass back as `resumeSessionId`. */
  sessionId?: string;
  /** Final answer (Claude Code). */
  text?: string;
  /** Native engine: the messages produced by this turn, to append to the conversation. */
  messages?: ChatMessage[];
  usage: Required<Usage>;
  /** `<connection or engine>/<model>`, as in the commit trailer. */
  ai: string;
  detail?: string;
  rateLimited?: boolean;
  resetsAt?: Date;
  commit?: CommitResult;
}

export type RunnerEvent =
  | ClaudeCodeEvent
  | { type: 'run'; runId: string }
  | { type: 'commit'; commit: string; files: string[] }
  | RunResultEvent;

/**
 * Whether a user has linked a subscription CLI, as the AI tab shows it (E8.9). The runner has
 * no database: it only checks that the credentials file exists, never its content (FR-126).
 */
export interface SubscriptionStatus {
  /** The user the answer is about, taken from the session token, never from the caller. */
  username: string;
  cli: 'claude-code';
  linked: boolean;
}

/** A run that cannot start; mapped to an HTTP error by the server. */
export class RunError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunError';
  }
}

export interface RunnerOptions {
  cms: CmsClient;
  /** Where the changeset clones live: `<workspacesRoot>/<changesetId>`. */
  workspacesRoot: string;
  /** Per-user CLI profiles (volume `cli-auth`). */
  cliAuthRoot: string;
  /** Shell command of the PreToolUse hook, written into `.claude/settings.json`. */
  hookCommand: string;
  /** MCP server of cms-api; default `<cms.baseUrl>/_cms/internal/mcp`. */
  mcpUrl?: string;
  /** Claude Code executable; default `claude` from PATH. */
  claudeExecutable?: string;
  /** Extra environment for the CLI (tests use it for PATH). */
  claudeEnv?: Record<string, string>;
  /** Native engine factory; default: the AI gateway of cms-api. */
  createEngine?: (token: string) => ChatEngine & { connection?: string; model?: string };
  /** Maximum model calls of the native engine per turn. */
  maxSteps?: number;
}

export interface StartedRun {
  whoami: AgentWhoami;
  execute(emit: (event: RunnerEvent) => void, signal: AbortSignal): Promise<RunResultEvent>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const DEV_AGENT_SYSTEM_PROMPT = `You are the developer agent of AI-CMS. You work in the git clone of one changeset of the website repository (a Next.js site). Make the change the user asks for, keeping the existing structure and conventions. Only these commands can run: pnpm tsc, pnpm test, pnpm lint, pnpm drizzle-kit generate, git status, git diff. New dependencies need the user's confirmation: ask for it instead of adding them. Do not commit: the CMS commits your changes at the end of the turn. Answer the user in Italian.`;

export function createRunner(options: RunnerOptions) {
  const { cms } = options;
  const busy = new Set<string>();
  const mcpUrl = options.mcpUrl ?? `${cms.baseUrl}/_cms/internal/mcp`;

  /** `CLAUDE_CONFIG_DIR` of a user inside the `cli-auth` volume (TECHNICAL §7.4). */
  function configDirFor(username: string): string {
    try {
      return claudeCodeConfigDir(options.cliAuthRoot, username);
    } catch {
      throw new RunError(400, 'invalid_username', `Nome utente non valido: ${username}`);
    }
  }

  /** The session token behind the caller; the runner never takes a username from the request. */
  async function callerOf(token: string): Promise<AgentWhoami> {
    const whoami = await cms.whoami(token);
    if (!whoami) {
      throw new RunError(401, 'unauthenticated', 'Token di sessione agente mancante o scaduto.');
    }
    return whoami;
  }

  /**
   * Status of the caller's own subscription login. It can only be about the authenticated user,
   * so this endpoint cannot be used to find out whether an account exists (FR-125).
   */
  async function subscriptionStatus(token: string): Promise<SubscriptionStatus> {
    const whoami = await callerOf(token);
    return {
      username: whoami.username,
      cli: 'claude-code',
      linked: await hasClaudeCodeLogin(configDirFor(whoami.username)),
    };
  }

  async function workspaceFor(whoami: AgentWhoami): Promise<string> {
    const id = whoami.changesetId;
    if (!id || !UUID.test(id)) {
      throw new RunError(
        409,
        'no_changeset',
        "L'agente sviluppatore lavora solo dentro un changeset: la sessione non ne indica uno.",
      );
    }
    const dir = path.join(options.workspacesRoot, id);
    const info = await stat(path.join(dir, '.git')).catch(() => null);
    if (!info) {
      throw new RunError(409, 'no_workspace', `Il workspace del changeset ${id} non esiste.`);
    }
    return dir;
  }

  function mcpConfig(token: string): ClaudeCodeOptions['mcpConfig'] {
    return {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    };
  }

  async function runClaude(
    request: RunRequest,
    whoami: AgentWhoami,
    configDir: string,
    workspace: string | null,
    emit: (event: RunnerEvent) => void,
    signal: AbortSignal,
  ): Promise<{ result: ClaudeCodeResult; model?: string }> {
    let tempDir: string | undefined;
    const common: ClaudeCodeOptions = {
      prompt: request.prompt,
      cwd: '',
      configDir,
      mcpConfig: mcpConfig(request.token),
      permissionMode: 'dontAsk',
      signal,
      ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
      ...(options.claudeExecutable ? { executable: options.claudeExecutable } : {}),
    };
    let cli: ClaudeCodeOptions;
    if (whoami.agent === 'dev-agent' && workspace) {
      await prepareClaudeWorkspace(workspace, { hookCommand: options.hookCommand });
      cli = {
        ...common,
        cwd: workspace,
        tools: DEV_AGENT_CLI_TOOLS,
        allowedTools: devAgentAllowRules(),
        disallowedTools: devAgentDenyRules(),
        appendSystemPrompt: DEV_AGENT_SYSTEM_PROMPT,
        // Inherited by the PreToolUse hook.
        env: {
          ...options.claudeEnv,
          CMS_API_URL: cms.baseUrl,
          CMS_AGENT_TOKEN: request.token,
          CMS_WORKSPACE: workspace,
        },
      };
    } else {
      // Content agent: no built-in tool at all (files, shell, web), only the CMS tools.
      tempDir = await mkdtemp(path.join(tmpdir(), 'cms-content-agent-'));
      cli = {
        ...common,
        cwd: tempDir,
        tools: [],
        allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
        ...(options.claudeEnv ? { env: { ...options.claudeEnv } } : {}),
      };
    }
    try {
      let model: string | undefined;
      const stream = streamClaudeCode(cli);
      for (;;) {
        const next = await stream.next();
        if (next.done) return { result: next.value, ...(model ? { model } : {}) };
        if (next.value.type === 'session' && next.value.model) model = next.value.model;
        emit(next.value);
      }
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  }

  async function commitIfNeeded(
    request: RunRequest,
    whoami: AgentWhoami,
    workspace: string,
    ai: string,
    emit: (event: RunnerEvent) => void,
  ): Promise<CommitResult | undefined> {
    try {
      const commit = await commitTurn(
        workspace,
        {
          name: whoami.username,
          email: whoami.email || `${whoami.username}@users.cms.local`,
        },
        {
          prompt: request.prompt,
          agent: whoami.agent,
          ai,
          conversationId: whoami.conversationId,
        },
      );
      if (!commit) return undefined;
      emit({ type: 'commit', ...commit });
      return commit;
    } catch (err) {
      emit({
        type: 'error',
        message: `Commit delle modifiche non riuscito: ${err instanceof Error ? err.message : String(err)}`,
      });
      return undefined;
    }
  }

  /**
   * Validates a run request and reserves its workspace. Throws RunError before anything is
   * streamed, so the server can answer with a plain HTTP error.
   */
  async function start(request: RunRequest): Promise<StartedRun> {
    const whoami = await callerOf(request.token);
    const isDev = whoami.agent === 'dev-agent';
    if (!isDev && request.engine === 'native') {
      throw new RunError(
        400,
        'unsupported_engine',
        "Il motore nativo dell'agente contenuti gira in cms-api, non nell'agent-runner.",
      );
    }
    const workspace = isDev ? await workspaceFor(whoami) : null;

    let configDir: string | undefined;
    if (request.engine === 'claude-code') {
      // Always the profile of the user who asked (TECHNICAL §7.4): never someone else's.
      configDir = configDirFor(whoami.username);
      if (!(await hasClaudeCodeLogin(configDir))) {
        throw new RunError(
          412,
          'subscription_not_connected',
          `Collega il tuo abbonamento con make connect-claude-code user=${whoami.username}`,
        );
      }
    }

    if (workspace) {
      if (busy.has(workspace)) {
        throw new RunError(
          409,
          'busy',
          "Un'altra esecuzione dell'agente è in corso su questo changeset.",
        );
      }
      busy.add(workspace);
    }

    return {
      whoami,
      async execute(emit, signal) {
        try {
          let final: RunResultEvent;
          if (request.engine === 'claude-code') {
            const { result, model } = await runClaude(
              request,
              whoami,
              configDir!,
              workspace,
              emit,
              signal,
            );
            const ai = `claude-code/${model ?? 'default'}`;
            final = {
              type: 'result',
              engine: 'claude-code',
              agent: whoami.agent,
              stopReason: result.stopReason,
              ...(result.sessionId ? { sessionId: result.sessionId } : {}),
              text: result.text,
              usage: result.usage,
              ai,
              ...(result.detail ? { detail: result.detail } : {}),
              ...(result.rateLimited ? { rateLimited: true } : {}),
              ...(result.resetsAt ? { resetsAt: result.resetsAt } : {}),
            };
          } else {
            const engine =
              options.createEngine?.(request.token) ??
              new GatewayChatEngine({ baseUrl: cms.baseUrl, token: request.token });
            const tools = createDevTools({
              root: workspace!,
              authorize: async (use) => {
                const decision = await cms.authorize(request.token, use);
                if (!decision.allowed) throw new Error(decision.message);
              },
            });
            const result = await runAgent({
              engine,
              // The gateway always uses the model assigned to the role.
              model: 'default',
              system: DEV_AGENT_SYSTEM_PROMPT,
              messages: [
                ...(request.messages ?? []),
                { role: 'user', content: [{ type: 'text', text: request.prompt }] },
              ],
              tools,
              signal,
              onEvent: emit,
              ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
            });
            final = {
              type: 'result',
              engine: 'native',
              agent: whoami.agent,
              stopReason: result.stopReason,
              messages: result.messages,
              usage: result.usage,
              ai: `${engine.connection ?? 'native'}/${engine.model ?? 'default'}`,
              ...(result.detail ? { detail: result.detail } : {}),
            };
          }
          if (workspace) {
            const commit = await commitIfNeeded(request, whoami, workspace, final.ai, emit);
            if (commit) final.commit = commit;
          }
          emit(final);
          return final;
        } finally {
          if (workspace) busy.delete(workspace);
        }
      },
    };
  }

  return {
    start,
    subscriptionStatus,
    /** Workspaces with a run in progress. */
    get busy(): ReadonlySet<string> {
      return busy;
    },
  };
}

export type Runner = ReturnType<typeof createRunner>;
