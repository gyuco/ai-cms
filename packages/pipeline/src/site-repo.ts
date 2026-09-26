import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { GitError, runGit } from './git.ts';
import { installPreReceiveHook } from './pre-receive.ts';

/** Where the site repository and the changeset clones live (docker volumes in production). */
export interface SiteRepoPaths {
  /** Contains the bare repository `site.git`. */
  gitRoot: string;
  /** Contains one working clone per changeset, `<workspacesRoot>/<changesetId>`. */
  workspacesRoot: string;
}

/** Paths from GIT_ROOT and WORKSPACES_ROOT, defaulting to the worker's volume mounts. */
export function siteRepoPaths(env: NodeJS.ProcessEnv = process.env): SiteRepoPaths {
  return {
    gitRoot: env.GIT_ROOT || '/data/git',
    workspacesRoot: env.WORKSPACES_ROOT || '/data/workspaces',
  };
}

export function bareRepoPath(gitRoot: string): string {
  return join(gitRoot, 'site.git');
}

/** Build output and local state that never belong in the site repository. */
const EXCLUDED_NAMES = new Set(['node_modules', '.next', '.turbo', 'tsconfig.tsbuildinfo']);

const DEFAULT_GITIGNORE = `node_modules/
.next/
.turbo/
*.tsbuildinfo
next-env.d.ts
.env*
`;

/** Resolves a ref to a commit id, or null when it does not exist. */
export async function resolveRef(bareRepo: string, ref: string): Promise<string | null> {
  try {
    const out = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: bareRepo,
    });
    return out.trim() || null;
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface InitSiteRepoOptions {
  gitRoot: string;
  /** The site skeleton, `templates/site` in the monorepo. */
  templateDir: string;
}

export interface InitSiteRepoResult {
  /** True when this call imported the template. */
  created: boolean;
  main: string;
  staging: string;
}

/**
 * Creates `site.git` from the template, with `main` and `staging` on the same initial commit,
 * and (re)installs the pre-receive hook. Safe to run at every worker start.
 */
export async function initSiteRepo(options: InitSiteRepoOptions): Promise<InitSiteRepoResult> {
  const bare = bareRepoPath(options.gitRoot);
  await mkdir(options.gitRoot, { recursive: true });
  if (!(await exists(join(bare, 'HEAD')))) {
    await runGit(['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  }
  await installPreReceiveHook(bare);

  let created = false;
  let main = await resolveRef(bare, 'refs/heads/main');
  if (!main) {
    await importTemplate(bare, options.templateDir);
    main = (await resolveRef(bare, 'refs/heads/main'))!;
    created = true;
  }
  let staging = await resolveRef(bare, 'refs/heads/staging');
  if (!staging) {
    // Only reachable if a previous init stopped half-way; '' asserts the ref is still absent.
    await runGit(['update-ref', 'refs/heads/staging', main, ''], { cwd: bare });
    staging = main;
  }
  return { created, main, staging };
}

async function importTemplate(bare: string, templateDir: string): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'ai-cms-site-init-'));
  try {
    const work = join(temp, 'site');
    await cp(templateDir, work, {
      recursive: true,
      filter: (source) => !EXCLUDED_NAMES.has(basename(source)),
    });
    if (!(await exists(join(work, '.gitignore')))) {
      await writeFile(join(work, '.gitignore'), DEFAULT_GITIGNORE);
    }
    await runGit(['init', '--quiet', '--initial-branch=main'], { cwd: work });
    await runGit(['add', '--all'], { cwd: work });
    await runGit(['commit', '--quiet', '--no-verify', '-m', 'Sito iniziale dal modello'], {
      cwd: work,
    });
    await runGit(['push', '--quiet', bare, 'main:refs/heads/main', 'main:refs/heads/staging'], {
      cwd: work,
      env: { CMS_GIT_ACTOR: 'release' },
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
