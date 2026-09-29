import { checkCommand, PROTECTED_DIRS } from '@ai-cms/agents';
import { defineTool, type Tool } from '@ai-cms/ai';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ToolUse } from './cms-client.ts';
import { resolveInWorkspace } from './workspace.ts';

/**
 * Coding tools of the developer agent's native engine (TECHNICAL §7.6). Every tool is bound
 * to the changeset clone (no path outside it, no symlink leading out) and asks cms-api's
 * `authorize` endpoint before acting, like the Claude Code hook does.
 */

export interface DevToolsOptions {
  /** The changeset clone. */
  root: string;
  /** Throws when the tool use is not allowed; its message goes back to the model. */
  authorize(use: ToolUse): Promise<void>;
  /** Packages the user approved in the chat: `run` accepts `pnpm add` for these only. */
  approvedDependencies?: readonly string[];
  runTimeoutMs?: number;
  /** Characters of command or search output kept for the model. */
  maxOutputChars?: number;
  /** Search program; `null` forces the built-in search. Default `rg` from PATH. */
  ripgrep?: string | null;
}

const MAX_READ_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 2000;
const MAX_SEARCH_MATCHES = 200;
const SKIPPED_DIRS = new Set<string>([...PROTECTED_DIRS, 'node_modules', '.next', '.turbo']);

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // The end of a command's output (errors, summary) is usually what matters.
  return `[… ${text.length - max} caratteri omessi …]\n${text.slice(-max)}`;
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/** Lists files under `dir`, without following symlinks and skipping heavy or protected dirs. */
async function walk(
  root: string,
  dir: string,
  recursive: boolean,
  out: string[],
  limit: number,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= limit) return;
    const abs = path.join(dir, entry.name);
    const rel = toPosix(path.relative(root, abs));
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      out.push(`${rel}/`);
      if (recursive) await walk(root, abs, recursive, out, limit);
    } else if (entry.isSymbolicLink()) {
      out.push(`${rel}@`);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // Like ripgrep, a glob without a slash matches the file name at any depth.
  return new RegExp(glob.includes('/') ? `^${source}$` : `(^|/)${source}$`);
}

async function nodeSearch(
  root: string,
  start: string,
  pattern: RegExp,
  glob: RegExp | undefined,
): Promise<string[]> {
  const files: string[] = [];
  const info = await lstat(start);
  if (info.isFile()) files.push(toPosix(path.relative(root, start)));
  else if (info.isDirectory()) await walk(root, start, true, files, 50_000);
  const matches: string[] = [];
  for (const file of files) {
    if (file.endsWith('/') || file.endsWith('@')) continue;
    if (file.split('/').some((segment) => segment.startsWith('.'))) continue;
    if (glob && !glob.test(file)) continue;
    const content = await readFile(path.join(root, file), 'utf8').catch(() => '');
    if (content.includes('\0')) continue;
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      if (pattern.test(line)) {
        matches.push(`${file}:${index + 1}:${line}`);
        if (matches.length >= MAX_SEARCH_MATCHES) return matches;
      }
    }
  }
  return matches;
}

interface ExecResult {
  code: number | string | null;
  stdout: string;
  stderr: string;
}

function exec(
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env: Record<string, string> },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        shell: false,
      },
      (error, stdout, stderr) => {
        const code = error ? (error.killed ? 'timeout' : (error.code ?? null)) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** Environment of commands run by the agent: no token, no secrets, nothing from the runner. */
export function commandEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: tmpdir(),
    LANG: 'C.UTF-8',
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // No pnpm prompt or network update check.
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    NO_UPDATE_NOTIFIER: '1',
  };
}

/** Git reads its config from the clone, which the agent could have changed: neutralize it. */
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

export function createDevTools(options: DevToolsOptions): Tool[] {
  const { root } = options;
  const maxOutput = options.maxOutputChars ?? 20_000;
  const runTimeoutMs = options.runTimeoutMs ?? 5 * 60_000;

  let realRoot: string | undefined;
  async function resolveRoot(): Promise<string> {
    realRoot ??= (await resolveInWorkspace(root, '')).abs;
    return realRoot;
  }

  async function resolve(tool: string, input: string) {
    const target = await resolveInWorkspace(root, input);
    await options.authorize({ tool, path: target.rel, exists: target.exists });
    return target;
  }

  const listFiles = defineTool({
    name: 'list_files',
    description:
      'Elenca file e cartelle del workspace del changeset. Le cartelle finiscono con "/", i collegamenti simbolici con "@".',
    input: z.object({
      path: z.string().default('').describe('Cartella relativa alla radice del workspace.'),
      recursive: z.boolean().default(false),
    }),
    async run({ path: dir, recursive }) {
      const target = await resolve('list_files', dir);
      if (!target.exists) throw new Error(`La cartella ${dir || '.'} non esiste.`);
      const out: string[] = [];
      await walk(await resolveRoot(), target.abs, recursive, out, MAX_LIST_ENTRIES);
      const suffix = out.length >= MAX_LIST_ENTRIES ? '\n[elenco troncato]' : '';
      return out.join('\n') + suffix;
    },
  });

  const readFileTool = defineTool({
    name: 'read_file',
    description:
      'Legge un file di testo del workspace. offset e limit (in righe, da 1) permettono di leggere file lunghi a pezzi.',
    input: z.object({
      path: z.string().min(1),
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).optional(),
    }),
    async run({ path: file, offset, limit }) {
      const target = await resolve('read_file', file);
      if (!target.exists) throw new Error(`Il file ${file} non esiste.`);
      const info = await lstat(target.abs);
      if (!info.isFile()) throw new Error(`${file} non è un file.`);
      if (info.size > MAX_READ_BYTES && offset === undefined && limit === undefined) {
        throw new Error(`Il file ${file} è troppo grande: leggilo a pezzi con offset e limit.`);
      }
      const content = await readFile(target.abs, 'utf8');
      if (offset === undefined && limit === undefined) return content;
      const lines = content.split('\n');
      const start = (offset ?? 1) - 1;
      return lines.slice(start, limit === undefined ? undefined : start + limit).join('\n');
    },
  });

  const writeFileTool = defineTool({
    name: 'write_file',
    description: 'Crea un file o ne sostituisce tutto il contenuto.',
    input: z.object({ path: z.string().min(1), content: z.string() }),
    async run({ path: file, content }) {
      const target = await resolve('write_file', file);
      if (target.exists && !(await lstat(target.abs)).isFile()) {
        throw new Error(`${file} non è un file.`);
      }
      await mkdir(path.dirname(target.abs), { recursive: true });
      await writeFile(target.abs, content, 'utf8');
      return target.exists ? `Aggiornato ${target.rel}.` : `Creato ${target.rel}.`;
    },
  });

  const editFile = defineTool({
    name: 'edit_file',
    description:
      'Sostituisce in un file un testo esatto che deve comparire una sola volta. Includi abbastanza contesto da renderlo univoco.',
    input: z.object({
      path: z.string().min(1),
      old_string: z.string().min(1),
      new_string: z.string(),
    }),
    async run({ path: file, old_string: oldString, new_string: newString }) {
      const target = await resolve('edit_file', file);
      if (!target.exists) throw new Error(`Il file ${file} non esiste.`);
      const content = await readFile(target.abs, 'utf8');
      const first = content.indexOf(oldString);
      if (first < 0) throw new Error(`Testo da sostituire non trovato in ${file}.`);
      if (content.indexOf(oldString, first + 1) >= 0) {
        throw new Error(
          `Il testo da sostituire compare più volte in ${file}: aggiungi contesto per renderlo univoco.`,
        );
      }
      await writeFile(
        target.abs,
        content.slice(0, first) + newString + content.slice(first + oldString.length),
        'utf8',
      );
      return `Modificato ${target.rel}.`;
    },
  });

  const search = defineTool({
    name: 'search',
    description:
      'Cerca un\'espressione regolare nei file del workspace. Restituisce righe "file:riga:testo".',
    input: z.object({
      pattern: z.string().min(1),
      path: z.string().default(''),
      glob: z.string().optional().describe('Filtro sui nomi dei file, es. "*.tsx".'),
    }),
    async run({ pattern, path: dir, glob }) {
      if (glob && (glob.startsWith('/') || glob.split('/').includes('..'))) {
        throw new Error('Filtro non consentito: deve restare dentro il workspace.');
      }
      let regexp: RegExp;
      try {
        regexp = new RegExp(pattern);
      } catch {
        throw new Error(`Espressione regolare non valida: ${pattern}`);
      }
      const target = await resolve('search', dir);
      if (!target.exists) throw new Error(`Il percorso ${dir || '.'} non esiste.`);
      const base = await resolveRoot();
      const rg = options.ripgrep === undefined ? 'rg' : options.ripgrep;
      if (rg) {
        const result = await exec(
          rg,
          [
            '--line-number',
            '--no-heading',
            '--color=never',
            '--max-count=50',
            '--max-columns=500',
            ...(glob ? ['--glob', glob] : []),
            '--glob=!.git',
            '--glob=!.claude',
            '-e',
            pattern,
            // An explicit path, or rg would search its stdin.
            '--',
            target.rel || '.',
          ],
          { cwd: base, timeoutMs: 60_000, env: commandEnv() },
        );
        if (result.code === 0) {
          const out = result.stdout.trimEnd().replace(/^\.\//gm, '');
          return truncate(out, maxOutput);
        }
        if (result.code === 1) return 'Nessun risultato.';
        if (result.code !== 'ENOENT') {
          throw new Error(`Ricerca non riuscita: ${result.stderr.trim() || result.code}`);
        }
      }
      const matches = await nodeSearch(
        base,
        target.abs,
        regexp,
        glob ? globToRegExp(glob) : undefined,
      );
      return matches.length ? truncate(matches.join('\n'), maxOutput) : 'Nessun risultato.';
    },
  });

  const run = defineTool({
    name: 'run',
    description:
      "Esegue un comando nel workspace, senza shell. Consentiti solo: git status, git diff, e `pnpm add <pacchetto> --ignore-scripts --ignore-pnpmfile` per i pacchetti che l'utente ha approvato in chat. Test, lint, tipi, build e migrazioni non girano qui: li esegue il builder a fine turno.",
    input: z.object({ command: z.string().min(1).max(2000) }),
    async run({ command }) {
      const check = checkCommand(command, {
        approvedDependencies: options.approvedDependencies ?? [],
      });
      if (!check.allowed) throw new Error(check.message);
      await options.authorize({ tool: 'run', command });
      const [program, ...args] = check.argv;
      const argv = program === 'git' ? [...GIT_SAFE_CONFIG, ...args] : args;
      const result = await exec(program!, argv, {
        cwd: await resolveRoot(),
        timeoutMs: runTimeoutMs,
        env: commandEnv(),
      });
      const status =
        result.code === 'timeout'
          ? `Interrotto dopo ${Math.round(runTimeoutMs / 1000)} secondi.`
          : `Codice di uscita: ${result.code}`;
      const output = [result.stdout, result.stderr].filter((s) => s.trim()).join('\n');
      return `${status}\n${truncate(output, maxOutput)}`;
    },
  });

  return [listFiles, readFileTool, writeFileTool, editFile, search, run] as Tool[];
}
