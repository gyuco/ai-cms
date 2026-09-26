/**
 * File policy of the developer agent, shared by the Claude Code hook and the native tools.
 * Paths are relative to the changeset clone, with `/` separators.
 */

/** Directories of the clone the agent never reads or writes: git internals and CLI settings. */
export const PROTECTED_DIRS = ['.git', '.claude'] as const;

export type FileAccess = 'read' | 'list' | 'write' | 'create';

export type RepoPathCheck =
  { ok: true; path: string } | { ok: false; code: string; message: string };

/**
 * Normalizes a clone-relative path (`''` is the clone root). Rejects absolute paths, `..`
 * segments and the protected directories: symlinks are resolved by the caller, which has the
 * filesystem.
 */
export function normalizeRepoPath(input: string): RepoPathCheck {
  if (input.includes('\0') || input.includes('\\')) {
    return { ok: false, code: 'invalid-path', message: `Percorso non valido: ${input}` };
  }
  if (input.startsWith('/')) {
    return {
      ok: false,
      code: 'outside-workspace',
      message: `Percorso fuori dal workspace del changeset: ${input}`,
    };
  }
  const segments = input.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    return {
      ok: false,
      code: 'outside-workspace',
      message: `Percorso fuori dal workspace del changeset: ${input}`,
    };
  }
  const first = segments[0];
  if (first && (PROTECTED_DIRS as readonly string[]).includes(first)) {
    return {
      ok: false,
      code: 'protected-path',
      message: `La cartella ${first} del workspace non è accessibile all'agente.`,
    };
  }
  return { ok: true, path: segments.join('/') };
}

/** Tools of both engines that touch files, with the access each one needs. */
const FILE_TOOLS: Record<string, FileAccess> = {
  // Claude Code built-in tools.
  Read: 'read',
  Grep: 'read',
  Glob: 'list',
  Edit: 'write',
  Write: 'write',
  // Native engine tools.
  read_file: 'read',
  search: 'read',
  list_files: 'list',
  edit_file: 'write',
  write_file: 'write',
};

/** Tools that run a command line. */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(['Bash', 'run']);

/**
 * The access a file tool needs, or undefined for tools that are not file tools. Writing a
 * file that does not exist yet is a creation.
 */
export function fileAccessFor(tool: string, exists = true): FileAccess | undefined {
  const access = Object.hasOwn(FILE_TOOLS, tool) ? FILE_TOOLS[tool] : undefined;
  if (access === 'write' && !exists) return 'create';
  return access;
}
