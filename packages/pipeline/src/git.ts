import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

/** Author and committer of the commits made by the platform itself. */
export const SYSTEM_GIT_IDENTITY = { name: 'AI-CMS', email: 'system@localhost' };

/** Who is pushing to site.git; checked by the pre-receive hook. */
export type GitActor = 'changeset' | 'release';

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly code: number | string | null,
  ) {
    super(`git ${args.find((a) => !a.startsWith('-')) ?? ''} failed: ${stderr.trim() || code}`);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  cwd?: string;
  /** Extra environment variables, e.g. CMS_GIT_ACTOR. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Runs git without a shell and with a minimal environment: no terminal prompts, no system or
 * global config, and the platform identity for the commits made here.
 */
export function runGit(args: string[], options: GitOptions = {}): Promise<string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: tmpdir(),
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: SYSTEM_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: SYSTEM_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: SYSTEM_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: SYSTEM_GIT_IDENTITY.email,
    ...options.env,
  };
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        // Cast: Next.js (cms-api imports this package) augments ProcessEnv with NODE_ENV.
        env: env as NodeJS.ProcessEnv,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = error.killed ? 'timeout' : (error.code ?? null);
          reject(new GitError(args, stderr || error.message, code));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}
