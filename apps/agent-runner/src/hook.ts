import type { ToolDecision, ToolUse } from './cms-client.ts';
import { MCP_SERVER_NAME } from './claude-settings.ts';
import { resolveInWorkspace, WorkspaceError } from './workspace.ts';

/**
 * `PreToolUse` hook of Claude Code for the developer agent (E10.6). Input and output follow
 * code.claude.com/docs/en/hooks: the event arrives as JSON on stdin (`tool_name`,
 * `tool_input`, `cwd`…); to block, the hook prints `hookSpecificOutput.permissionDecision =
 * "deny"` and exits with code 2, which blocks whatever the JSON says and shows the reason to
 * Claude. Exit 0 with no output leaves the call to the normal permission rules. A failed or
 * timed-out hook does not block, so every error here is turned into a denial.
 */

export interface PreToolUseInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface HookEnv {
  /** The changeset clone. */
  workspace: string;
  authorize(use: ToolUse): Promise<ToolDecision>;
}

export type HookVerdict = { allow: true } | { allow: false; reason: string };

const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write']);
const DIR_PATH_TOOLS = new Set(['Glob', 'Grep']);

function deny(reason: string): HookVerdict {
  return { allow: false, reason };
}

function escapesWorkspace(pattern: string): boolean {
  return pattern.startsWith('/') || pattern.startsWith('~') || pattern.split('/').includes('..');
}

export async function decidePreToolUse(input: PreToolUseInput, env: HookEnv): Promise<HookVerdict> {
  const tool = input.tool_name;
  const args = input.tool_input ?? {};
  if (typeof tool !== 'string' || !tool) return deny('Richiesta dello strumento non valida.');
  // CMS tools check permissions themselves on the MCP server (FR-132).
  if (tool.startsWith(`mcp__${MCP_SERVER_NAME}__`)) return { allow: true };

  let use: ToolUse;
  if (tool === 'Bash') {
    if (typeof args.command !== 'string') return deny('Comando mancante.');
    if (args.run_in_background === true) {
      return deny('I comandi in background non sono consentiti.');
    }
    use = { tool, command: args.command };
  } else if (FILE_PATH_TOOLS.has(tool) || DIR_PATH_TOOLS.has(tool)) {
    const raw = FILE_PATH_TOOLS.has(tool) ? args.file_path : (args.path ?? '');
    if (typeof raw !== 'string') return deny('Percorso mancante.');
    // Glob patterns (Glob `pattern`, Grep `glob`) could also point outside the clone.
    const filter = tool === 'Glob' ? args.pattern : tool === 'Grep' ? args.glob : undefined;
    if (typeof filter === 'string' && escapesWorkspace(filter)) {
      return deny(`Il filtro ${filter} deve restare dentro il workspace del changeset.`);
    }
    try {
      const target = await resolveInWorkspace(env.workspace, raw);
      use = { tool, path: target.rel, exists: target.exists };
    } catch (err) {
      if (err instanceof WorkspaceError) return deny(err.message);
      throw err;
    }
  } else {
    return deny(`Strumento non consentito all'agente sviluppatore: ${tool}.`);
  }

  const decision = await env.authorize(use);
  return decision.allowed ? { allow: true } : deny(decision.message);
}

export interface HookOutput {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

/**
 * Runs the hook on the raw stdin text. `env` is the hook process environment: the runner
 * passes `CMS_WORKSPACE`, `CMS_API_URL` and `CMS_AGENT_TOKEN` to the CLI, which hooks inherit.
 */
export async function runPreToolUseHook(
  stdin: string,
  createEnv: () => HookEnv,
): Promise<HookOutput> {
  let verdict: HookVerdict;
  try {
    const input = JSON.parse(stdin) as PreToolUseInput;
    verdict = await decidePreToolUse(input, createEnv());
  } catch (err) {
    verdict = deny(
      `Impossibile verificare i permessi: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (verdict.allow) return { exitCode: 0, stdout: '', stderr: '' };
  return {
    exitCode: 2,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: verdict.reason,
      },
    }),
    stderr: verdict.reason,
  };
}
