/**
 * Shell policy of the developer agent (TECHNICAL §7.6): only the commands in the allowlist
 * run, with no shell features. Shared by the Claude Code hook (checked in cms-api) and the
 * native `run` tool, so both engines accept exactly the same commands.
 *
 * Nothing that executes the site's code runs in the agent-runner (E13.4): tests, lint, type
 * checks, builds and migration generation read files the agent wrote, and the runner holds the
 * subscription logins in `/cli-auth`. Those checks run in the builder, after the CMS saves the
 * agent's work at the end of the turn.
 */

/** Allowed commands, as argv prefixes; any further argument is checked by `checkCommand`. */
export const ALLOWED_COMMANDS: readonly (readonly string[])[] = [
  ['git', 'status'],
  ['git', 'diff'],
];

/** Programs that would run the site's code (or arbitrary code) if the agent could call them. */
const CODE_RUNNERS = new Set([
  'pnpm',
  'npm',
  'npx',
  'yarn',
  'bun',
  'node',
  'tsx',
  'ts-node',
  'tsc',
  'vitest',
  'eslint',
  'next',
  'drizzle-kit',
  'sh',
  'bash',
  'zsh',
  'python',
  'python3',
  'make',
  'env',
]);

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

// npm package names (scoped or not) and the version specs the agent may pick: never a URL,
// a git reference or a local path, which would install code the user did not approve.
const PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const VERSION_SPEC = /^[A-Za-z0-9.^~<>=*+-]{1,64}$/;
const DEPENDENCY_FLAGS = new Set(['-D', '--save-dev', '-E', '--save-exact']);
/** Install scripts of a new package run with the network open, so they never run. */
const IGNORE_SCRIPTS = '--ignore-scripts';
/** `.pnpmfile.cjs` is site code that pnpm loads on every install, so it never loads either. */
const IGNORE_PNPMFILE = '--ignore-pnpmfile';

/** Splits `name@1.2.3` and `@scope/name@^1` into name and (optional) version. */
function splitPackageSpec(spec: string): { name: string; version?: string } | null {
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : undefined;
  if (!PACKAGE_NAME.test(name)) return null;
  if (version !== undefined && !VERSION_SPEC.test(version)) return null;
  return version === undefined ? { name } : { name, version };
}

/**
 * `pnpm add` after the user approved the packages in the chat (FR-37). Every package must be
 * one of the approved names, and the command may only use the flags above plus
 * `--ignore-scripts` and `--ignore-pnpmfile`, which are mandatory.
 */
function checkDependencyAdd(argv: string[], approved: readonly string[]): CommandCheck {
  const deny = (message: string): CommandCheck => ({
    allowed: false,
    code: 'dependency-add',
    message,
  });
  if (argv[0] !== 'pnpm' || argv[1] !== 'add') {
    return deny(
      "Solo `pnpm add` è consentito per le dipendenze, e solo dopo l'approvazione dell'utente in chat.",
    );
  }
  const rest = argv.slice(2);
  const flags = rest.filter((arg) => arg.startsWith('-'));
  const specs = rest.filter((arg) => !arg.startsWith('-'));
  const badFlag = flags.find(
    (flag) => flag !== IGNORE_SCRIPTS && flag !== IGNORE_PNPMFILE && !DEPENDENCY_FLAGS.has(flag),
  );
  if (badFlag !== undefined) {
    return {
      allowed: false,
      code: 'forbidden-argument',
      message: `Argomento non consentito: ${badFlag}.`,
    };
  }
  if (!flags.includes(IGNORE_SCRIPTS) || !flags.includes(IGNORE_PNPMFILE)) {
    return deny(
      `Aggiungi ${IGNORE_SCRIPTS} e ${IGNORE_PNPMFILE}: script di installazione e .pnpmfile.cjs non possono girare.`,
    );
  }
  if (specs.length === 0) return deny('Indica il pacchetto da aggiungere.');
  for (const spec of specs) {
    const parsed = splitPackageSpec(spec);
    if (!parsed) {
      return {
        allowed: false,
        code: 'forbidden-argument',
        message: `Pacchetto non valido: ${spec}. Sono ammessi solo nomi npm con una versione.`,
      };
    }
    if (!approved.includes(parsed.name)) {
      return deny(
        `Il pacchetto ${parsed.name} non è stato approvato: chiedi all'utente di approvarne l'aggiunta.`,
      );
    }
  }
  return { allowed: true, argv };
}

export interface CheckCommandOptions {
  /** Package names the user approved in the chat for this session. */
  approvedDependencies?: readonly string[];
}

export function describeAllowedCommands(): string {
  return ALLOWED_COMMANDS.map((argv) => argv.join(' ')).join(', ');
}

/** Decides whether the developer agent may run a command line. */
export function checkCommand(command: string, options: CheckCommandOptions = {}): CommandCheck {
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
    if (options.approvedDependencies?.length) {
      return checkDependencyAdd(argv, options.approvedDependencies);
    }
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
    const runsCode = CODE_RUNNERS.has(argv[0]!);
    return {
      allowed: false,
      code: 'not-allowed',
      message: runsCode
        ? `Comando non consentito: ${argv.slice(0, 2).join(' ')}. Il codice del sito non gira nel tuo ambiente: tipi, lint, test, build e migrazioni vengono controllati nel builder. Salva il lavoro: a fine turno il CMS lancia i controlli e ti rimanda gli errori (dove disponibile, usa lo strumento run_checks). Comandi ammessi: ${describeAllowedCommands()}.`
        : `Comando non consentito: ${argv[0]}. Comandi ammessi: ${describeAllowedCommands()}.`,
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
