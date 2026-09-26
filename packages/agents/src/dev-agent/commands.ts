/**
 * Shell policy of the developer agent (TECHNICAL §7.6): only the commands in the allowlist
 * run, with no shell features. Shared by the Claude Code hook (checked in cms-api) and the
 * native `run` tool, so both engines accept exactly the same commands.
 */

/** Allowed commands, as argv prefixes; any further argument is checked by `checkCommand`. */
export const ALLOWED_COMMANDS: readonly (readonly string[])[] = [
  ['pnpm', 'tsc'],
  ['pnpm', 'test'],
  ['pnpm', 'lint'],
  ['pnpm', 'drizzle-kit', 'generate'],
  ['git', 'status'],
  ['git', 'diff'],
];

export type CommandDenialCode =
  'unparsable' | 'not-allowed' | 'dependency-add' | 'forbidden-argument';

export type CommandCheck =
  { allowed: true; argv: string[] } | { allowed: false; code: CommandDenialCode; message: string };

// Characters that give a shell meaning to a command: pipes, lists, redirections,
// substitutions, globs, history and comments. None of them is ever needed by the allowlist.
const SHELL_META = /[;&|<>()$`\\{}*?[\]~!#\n\r\0]/;

/**
 * Splits a command line into argv, accepting plain words and single- or double-quoted
 * strings only. Returns null for anything a shell would interpret (see SHELL_META).
 */
export function splitCommand(command: string): string[] | null {
  const argv: string[] = [];
  let current: string | null = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === ' ' || ch === '\t') {
      if (current !== null) argv.push(current);
      current = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end < 0) return null;
      const quoted = command.slice(i + 1, end);
      if (SHELL_META.test(quoted)) return null;
      current = (current ?? '') + quoted;
      i = end + 1;
      continue;
    }
    if (SHELL_META.test(ch)) return null;
    current = (current ?? '') + ch;
    i++;
  }
  if (current !== null) argv.push(current);
  return argv;
}

const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const DEPENDENCY_SUBCOMMANDS = new Set(['add', 'install', 'i', 'update', 'up', 'upgrade']);

/** `pnpm add x`, `pnpm install x`, `npm i x`…: adding or changing a dependency. */
function isDependencyChange(argv: readonly string[]): boolean {
  const [tool, sub, ...rest] = argv;
  if (!tool || !sub || !PACKAGE_MANAGERS.has(tool) || !DEPENDENCY_SUBCOMMANDS.has(sub)) {
    return false;
  }
  // `add` always names packages; `install` and `update` change dependencies when they do.
  return sub === 'add' || rest.some((arg) => !arg.startsWith('-'));
}

// Options that point a tool at another directory or configuration, or make it write files.
const FORBIDDEN_OPTIONS = [
  '-C',
  '--dir',
  '--prefix',
  '--global',
  '-g',
  '--config',
  '--workspace-root',
  '-w',
  '--output',
  '--ext-diff',
  '--textconv',
];

function forbiddenArgument(arg: string): boolean {
  if (arg.startsWith('/') || arg.split(/[/=]/).includes('..')) return true;
  return FORBIDDEN_OPTIONS.some(
    (option) =>
      arg === option ||
      arg.startsWith(`${option}=`) ||
      (option.startsWith('--') && arg.startsWith(`${option}.`)) ||
      // Short options with an attached value, e.g. `-C/tmp`.
      (!option.startsWith('--') && arg.startsWith(option) && arg.length > option.length),
  );
}

export function describeAllowedCommands(): string {
  return ALLOWED_COMMANDS.map((argv) => argv.join(' ')).join(', ');
}

/** Decides whether the developer agent may run a command line. */
export function checkCommand(command: string): CommandCheck {
  const argv = splitCommand(command.trim());
  if (!argv || argv.length === 0) {
    return {
      allowed: false,
      code: 'unparsable',
      message:
        'Comando non consentito: sono ammessi solo comandi semplici, senza pipe, redirezioni, variabili o sostituzioni.',
    };
  }
  if (isDependencyChange(argv)) {
    return {
      allowed: false,
      code: 'dependency-add',
      message:
        "Le nuove dipendenze richiedono conferma: chiedi all'utente di approvare l'aggiunta del pacchetto.",
    };
  }
  const prefix = ALLOWED_COMMANDS.find((allowed) =>
    allowed.every((word, index) => argv[index] === word),
  );
  if (!prefix) {
    return {
      allowed: false,
      code: 'not-allowed',
      message: `Comando non consentito: ${argv[0]}. Comandi ammessi: ${describeAllowedCommands()}.`,
    };
  }
  const bad = argv.slice(prefix.length).find(forbiddenArgument);
  if (bad !== undefined) {
    return {
      allowed: false,
      code: 'forbidden-argument',
      message: `Argomento non consentito: ${bad}. I comandi possono lavorare solo dentro il workspace del changeset.`,
    };
  }
  return { allowed: true, argv };
}
