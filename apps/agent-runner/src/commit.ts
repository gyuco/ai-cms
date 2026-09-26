import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

/**
 * End-of-turn commit of the developer agent (TECHNICAL §7.6, E10.8): author = the user,
 * trailers `Agent`, `AI`, `Conversation`. Pushing to site.git stays with the worker
 * (`recordWork` in @ai-cms/pipeline): the runner only commits in the clone.
 */

/** Committer of the agent's commits; the author is the user. Same as pipeline's system identity. */
const COMMITTER = { name: 'AI-CMS', email: 'system@localhost' };

/**
 * The clone is written by the agent, so its git config and hooks are untrusted (same
 * overrides as `recordWork` in @ai-cms/pipeline): no hook, fsmonitor or signing program runs.
 */
const UNTRUSTED_REPO_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'gc.auto=0',
];

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git without a shell, with no system or global config and no terminal prompts. */
export function git(
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...UNTRUSTED_REPO_CONFIG, ...args],
      {
        cwd: options.cwd,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: tmpdir(),
          LC_ALL: 'C',
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_COMMITTER_NAME: COMMITTER.name,
          GIT_COMMITTER_EMAIL: COMMITTER.email,
          GIT_AUTHOR_NAME: COMMITTER.name,
          GIT_AUTHOR_EMAIL: COMMITTER.email,
          ...options.env,
        },
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(new Error(`git ${args[0]} non riuscito: ${stderr.trim() || error.message}`));
          return;
        }
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });
}

export interface CommitInfo {
  /** The user's request; its first line becomes the subject. */
  prompt: string;
  agent: string;
  /** `<connection or engine>/<model>`. */
  ai: string;
  conversationId: string | null;
}

const SUBJECT_MAX = 72;

/** Removes characters that would break a one-line commit subject or trailer. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

export function commitMessage(info: CommitInfo): string {
  const firstLine = oneLine(info.prompt.split('\n').find((line) => line.trim()) ?? '');
  let subject = firstLine || "Modifiche dell'agente sviluppatore";
  if (subject.length > SUBJECT_MAX) subject = `${subject.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
  const trailers = [`Agent: ${oneLine(info.agent)}`, `AI: ${oneLine(info.ai)}`];
  if (info.conversationId) trailers.push(`Conversation: ${oneLine(info.conversationId)}`);
  return `${subject}\n\n${trailers.join('\n')}\n`;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CommitResult {
  commit: string;
  files: string[];
}

/**
 * Commits every change in the clone (`git add -A`, so `.claude/`, excluded through
 * `.git/info/exclude`, stays out). Returns null when there is nothing to commit.
 */
export async function commitTurn(
  cwd: string,
  author: CommitAuthor,
  info: CommitInfo,
): Promise<CommitResult | null> {
  const check = (result: GitResult, what: string) => {
    if (result.code !== 0) throw new Error(`git ${what} non riuscito: ${result.stderr.trim()}`);
    return result.stdout;
  };
  check(await git(['add', '-A', '--', '.'], { cwd }), 'add');
  const staged = check(
    await git(['diff', '--cached', '--name-only', '-z', '--no-renames', '--no-ext-diff'], { cwd }),
    'diff',
  );
  const files = staged.split('\0').filter(Boolean);
  if (files.length === 0) return null;
  check(
    await git(['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', commitMessage(info)], {
      cwd,
      env: { GIT_AUTHOR_NAME: oneLine(author.name), GIT_AUTHOR_EMAIL: oneLine(author.email) },
    }),
    'commit',
  );
  const commit = check(await git(['rev-parse', 'HEAD'], { cwd }), 'rev-parse').trim();
  return { commit, files };
}
