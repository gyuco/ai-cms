import { normalizeRepoPath } from '@ai-cms/agents';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

/** A path the agent may not use: outside the clone, through a symlink, or protected. */
export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface WorkspacePath {
  /** Absolute path inside the clone. */
  abs: string;
  /** Relative to the clone root with `/` separators; `''` is the root itself. */
  rel: string;
  exists: boolean;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Real path of `target`, or of its nearest existing ancestor joined with the missing rest. */
async function resolveReal(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves a path the agent gave (absolute, or relative to the clone) and checks that it
 * stays inside the clone after following symlinks, and outside `.git` and `.claude`.
 */
export async function resolveInWorkspace(root: string, input: string): Promise<WorkspacePath> {
  const givenRoot = path.resolve(root);
  const realRoot = await realpath(givenRoot);
  let rel = input;
  if (path.isAbsolute(input)) {
    const normalized = path.resolve(input);
    const base = isInside(givenRoot, normalized) ? givenRoot : realRoot;
    rel = path.relative(base, normalized);
  }
  const check = normalizeRepoPath(rel.split(path.sep).join('/'));
  if (!check.ok) throw new WorkspaceError(check.code, check.message);

  const abs = path.join(realRoot, ...check.path.split('/').filter(Boolean));
  const real = await resolveReal(abs);
  if (!isInside(realRoot, real)) {
    throw new WorkspaceError(
      'outside-workspace',
      `Percorso fuori dal workspace del changeset: ${input} (collegamento simbolico verso l'esterno).`,
    );
  }
  // A symlink inside the clone may still point into a protected directory.
  const realCheck = normalizeRepoPath(path.relative(realRoot, real).split(path.sep).join('/'));
  if (!realCheck.ok) throw new WorkspaceError(realCheck.code, realCheck.message);

  return { abs, rel: check.path, exists: await exists(abs) };
}
