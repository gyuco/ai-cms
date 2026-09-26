import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { RunCommand } from './exec.ts';

/** Where the site lives inside the platform monorepo. */
export const SITE_DIR = 'templates/site';

/** Root entries of the monorepo that a site build needs; apps and docs are left out. */
const ROOT_ENTRIES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  '.npmrc',
  'packages',
  'templates',
]);

/** Build output, installed modules and VCS data never copied, from either side. */
const SKIPPED_NAMES = new Set(['node_modules', '.next', '.turbo', '.git', 'tsconfig.tsbuildinfo']);

/** Files of the changeset that could reconfigure pnpm or git for the whole workspace. */
const SITE_CONFIG_FILES = ['.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml', '.git'];

export interface Workspace {
  /** Private directory of the run, removed at the end. */
  dir: string;
  /** Copy of the platform monorepo with the changeset in place of the site template. */
  repo: string;
  /** `<repo>/templates/site`. */
  site: string;
  /** HOME and TMPDIR of the site commands. */
  home: string;
}

export interface PrepareOptions {
  platformRoot: string;
  workRoot: string;
  /** Working clone of the changeset (`/data/workspaces/<id>`), mounted read-only. */
  clone: string;
  commit: string;
  exec: RunCommand;
  env: Record<string, string>;
}

/**
 * git reading a clone written by the agent: the overrides keep its local config from running
 * anything, and `safe.directory` accepts a clone owned by the worker's user (only for
 * this command).
 */
function gitArgs(clone: string, args: string[]): string[] {
  return [
    '-c',
    'safe.directory=*',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '--git-dir',
    join(clone, '.git'),
    ...args,
  ];
}

/**
 * Builds the private workspace of a run: copies the platform monorepo (without apps and
 * without node_modules), then replaces `templates/site` with the files of the changeset commit.
 * The commit is exported with `git archive`, so uncommitted changes in the clone never count.
 */
export async function prepareWorkspace(options: PrepareOptions): Promise<Workspace> {
  await mkdir(options.workRoot, { recursive: true });
  const dir = await mkdtemp(join(options.workRoot, 'run-'));
  const repo = join(dir, 'repo');
  const site = join(repo, SITE_DIR);
  const home = join(dir, 'home');
  await mkdir(home);
  try {
    await cp(options.platformRoot, repo, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => {
        const rel = relative(options.platformRoot, source);
        if (rel === '') return true;
        const parts = rel.split(sep);
        if (!ROOT_ENTRIES.has(parts[0]!)) return false;
        if (rel === SITE_DIR || rel.startsWith(`${SITE_DIR}${sep}`)) return false;
        return !SKIPPED_NAMES.has(basename(source));
      },
    });

    const git = (args: string[]) =>
      options.exec('git', gitArgs(options.clone, args), {
        cwd: dir,
        env: { ...options.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        timeoutMs: 60_000,
      });
    const exists = await git(['cat-file', '-e', `${options.commit}^{commit}`]);
    if (exists.code !== 0) {
      throw new Error(`Il commit ${options.commit} non esiste nel clone del changeset.`);
    }
    const archive = join(dir, 'site.tar');
    const exported = await git(['archive', '--format=tar', '-o', archive, options.commit]);
    if (exported.code !== 0) throw new Error(`git archive non riuscito: ${exported.output}`);
    await mkdir(site, { recursive: true });
    const extracted = await options.exec('tar', ['-xf', archive, '-C', site], {
      cwd: dir,
      env: options.env,
      timeoutMs: 60_000,
    });
    if (extracted.code !== 0) throw new Error(`Estrazione non riuscita: ${extracted.output}`);
    await rm(archive, { force: true });
    await removeNamed(site, SKIPPED_NAMES);
    for (const name of SITE_CONFIG_FILES)
      await rm(join(site, name), { recursive: true, force: true });
    return { dir, repo, site, home };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Removes every directory entry with one of the names, at any depth. */
async function removeNamed(dir: string, names: ReadonlySet<string>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (names.has(entry.name)) await rm(path, { recursive: true, force: true });
    else if (entry.isDirectory()) await removeNamed(path, names);
  }
}
