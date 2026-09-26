import { ALLOWED_COMMANDS } from '@ai-cms/agents';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Claude Code restrictions for the developer agent (TECHNICAL §7.6, E10.6), following the
 * official settings and hooks reference (code.claude.com/docs/en/settings, /permissions,
 * /hooks):
 *
 * - `--tools` keeps only the built-in tools the agent needs;
 * - permission rules: `claude -p` ignores `permissions.allow` from an untrusted project's
 *   `.claude/settings.json`, so allow rules are passed on the command line (`--allowedTools`)
 *   and repeated in the file; deny rules apply from both;
 * - `dontAsk` mode denies anything no rule allows, instead of waiting for a prompt;
 * - a `PreToolUse` hook asks cms-api (authz + command allowlist) before every tool call and
 *   blocks with exit code 2. Hooks from project settings run in `-p` mode.
 */

/** Name of the CMS server in `--mcp-config`: its tools are `mcp__cms__<tool>`. */
export const MCP_SERVER_NAME = 'cms';

/** Built-in tools of the developer agent; everything else (web, subagents…) is removed. */
export const DEV_AGENT_CLI_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];

/** Allow rules. `/` anchors at the working directory, i.e. the changeset clone. */
export function devAgentAllowRules(): string[] {
  return [
    'Read',
    'Glob',
    'Grep',
    'Edit(/**)',
    ...ALLOWED_COMMANDS.map((argv) => `Bash(${argv.join(' ')} *)`),
    `mcp__${MCP_SERVER_NAME}__*`,
  ];
}

/** Deny rules: they win over any allow rule, whatever the settings source. */
export function devAgentDenyRules(): string[] {
  return [
    'WebFetch',
    'WebSearch',
    'Read(/.git/**)',
    'Edit(/.git/**)',
    'Read(/.claude/**)',
    'Edit(/.claude/**)',
    'Bash(curl *)',
    'Bash(wget *)',
    'Bash(ssh *)',
    'Bash(scp *)',
    'Bash(nc *)',
    'Bash(sudo *)',
    'Bash(rm -rf *)',
    'Bash(git push *)',
    'Bash(pnpm add *)',
    'Bash(pnpm install *)',
    'Bash(pnpm i *)',
    'Bash(npm *)',
    'Bash(npx *)',
  ];
}

export interface ClaudeSettings {
  $schema: string;
  permissions: {
    defaultMode: 'dontAsk';
    allow: string[];
    deny: string[];
    blockReadsOutsideWorkingDirectories: true;
    disableBypassPermissionsMode: 'disable';
  };
  disableAllHooks: false;
  hooks: {
    PreToolUse: {
      matcher: string;
      hooks: { type: 'command'; command: string; timeout: number }[];
    }[];
  };
}

/** Quotes a word for `sh -c`, which runs shell-form hook commands. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The project settings written in the clone. `hookCommand` is a shell command that runs the
 * hook script shipped in the runner image (outside the clone, so the agent cannot change it).
 */
export function buildClaudeSettings(options: { hookCommand: string }): ClaudeSettings {
  return {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    permissions: {
      defaultMode: 'dontAsk',
      allow: devAgentAllowRules(),
      deny: devAgentDenyRules(),
      blockReadsOutsideWorkingDirectories: true,
      disableBypassPermissionsMode: 'disable',
    },
    // Project settings override user settings: hooks stay on even if the profile turns them off.
    disableAllHooks: false,
    hooks: {
      PreToolUse: [
        {
          // Every tool: the hook lets CMS MCP tools through and denies unknown ones.
          matcher: '*',
          hooks: [{ type: 'command', command: options.hookCommand, timeout: 30 }],
        },
      ],
    },
  };
}

const EXCLUDE_LINE = '/.claude/';

/**
 * Writes `.claude/settings.json` in the clone and keeps `.claude/` out of the changeset's
 * commits through `.git/info/exclude`.
 */
export async function prepareClaudeWorkspace(
  root: string,
  options: { hookCommand: string },
): Promise<string> {
  const dir = path.join(root, '.claude');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  await writeFile(file, `${JSON.stringify(buildClaudeSettings(options), null, 2)}\n`, 'utf8');

  const exclude = path.join(root, '.git', 'info', 'exclude');
  const current = await readFile(exclude, 'utf8').catch(() => '');
  if (!current.split('\n').some((line) => line.trim() === EXCLUDE_LINE)) {
    await mkdir(path.dirname(exclude), { recursive: true });
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    await writeFile(exclude, `${current}${separator}${EXCLUDE_LINE}\n`, 'utf8');
  }
  return file;
}
