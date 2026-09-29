import { execFile } from 'node:child_process';
import { access, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAudit } from '@ai-cms/audit';
import { schema, type Database } from '@ai-cms/db';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { BuilderClient } from './builder-client.ts';
import {
  setChangesetStatus,
  UNTRUSTED_REPO_CONFIG,
  workspacePath,
  ChangesetError,
  type Changeset,
} from './changesets.ts';
import { runChangesetChecks, type RunChecksOptions } from './checks.ts';
import { GitError, runGit } from './git.ts';
import {
  applySiteMigrations,
  findDestructiveStatements,
  pendingSiteMigrations,
  readSiteMigrations,
  tablesTouchedBy,
} from './migrations.ts';
import { bareRepoPath, resolveRef, siteRepoPaths, type SiteRepoPaths } from './site-repo.ts';

/** Name of the pointer to the release being served, inside the releases volume. */
export const CURRENT_RELEASE_LINK = 'current';

/** Another release holds the global lock: the queue retries the job later. */
export class ReleaseBusyError extends Error {
  constructor() {
    super('Un’altra release è in corso: questa attende il suo turno.');
    this.name = 'ReleaseBusyError';
  }
}

/** A step of the release failed for a reason the person approving can act on. */
export class ReleaseError extends Error {
  constructor(
    readonly step: ReleaseStep,
    message: string,
  ) {
    super(message);
    this.name = 'ReleaseError';
  }
}

export type ReleaseStep =
  | 'prepare'
  | 'rebase'
  | 'checks'
  | 'build'
  | 'backup'
  | 'migrate'
  | 'activate'
  | 'health'
  | 'merge';

/** Writes a `pg_dump` of the given tables to `file`; returns false when there was nothing to dump. */
export type DumpTables = (input: {
  databaseUrl: string;
  tables: readonly string[];
  file: string;
}) => Promise<boolean>;

export interface ReleaseOptions {
  site?: SiteRepoPaths;
  /** The releases volume: `<releasesRoot>/<release_id>/` and the `current` pointer. */
  releasesRoot: string;
  /** Where `pg_dump` files go (`/data/backups`). */
  backupsRoot: string;
  /** Builds `releases/<id>/` in the builder service. */
  builder: Pick<BuilderClient, 'buildRelease'>;
  /** `app_owner` connection to `app_prod`: the only credentials that may migrate production. */
  prodOwnerUrl: () => string;
  /** Options of the checks that run again when `main` moved (TECHNICAL §8.4 step 2). */
  checks?: RunChecksOptions;
  /** Reruns the checks of a changeset on its rebased branch; tests replace it. */
  rerunChecks?: (
    changesetId: string,
  ) => Promise<Extract<Changeset['status'], 'ready' | 'checks_failed'>>;
  dump?: DumpTables;
  /** Makes `site-prod` pick up the new `current`; a no-op when it watches the pointer itself. */
  restart?: () => Promise<void>;
  /** Throws when `site-prod` does not answer correctly on the new release. */
  healthCheck?: () => Promise<void>;
}

export type ReleaseOutcome =
  | { status: 'released'; releaseId: string; number: number; commit: string; tag: string }
  | { status: 'failed'; releaseId: string; step: ReleaseStep | 'unknown'; error: string }
  | { status: 'skipped'; releaseId: string; reason: string };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `ancestor` is reachable from `descendant` (or the same commit). */
export async function isAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repo });
    return true;
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return false;
    throw error;
  }
}

/**
 * Points `<releasesRoot>/current` at a release (or removes the pointer when `target` is null).
 * The symlink is replaced with a rename, so a reader sees the old or the new release, never
 * a missing one.
 */
export async function switchCurrentRelease(
  releasesRoot: string,
  target: string | null,
): Promise<void> {
  const link = join(releasesRoot, CURRENT_RELEASE_LINK);
  if (target === null) {
    await rm(link, { force: true });
    return;
  }
  const tmp = `${link}.tmp-${process.pid}`;
  await rm(tmp, { force: true });
  await symlink(target, tmp);
  await rename(tmp, link);
}

/** The release id `current` points at, or null. */
export async function readCurrentRelease(releasesRoot: string): Promise<string | null> {
  try {
    return await readlink(join(releasesRoot, CURRENT_RELEASE_LINK));
  } catch {
    return null;
  }
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const qualified = (table: string) => table.split('.').map(quoteIdent).join('.');

/** `pg_dump` (custom format) of the tables that exist; the password goes through the environment. */
export const pgDumpTables: DumpTables = async ({ databaseUrl, tables, file }) => {
  const conn = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  let existing: string[];
  try {
    const found = await Promise.all(
      tables.map(async (table) => {
        const [row] = await conn<Array<{ found: boolean }>>`
          SELECT to_regclass(${qualified(table)}) IS NOT NULL AS found`;
        return row?.found ? table : null;
      }),
    );
    existing = found.filter((t): t is string => t !== null);
  } finally {
    await conn.end();
  }
  if (existing.length === 0) return false;

  const url = new URL(databaseUrl);
  const password = decodeURIComponent(url.password);
  url.password = '';
  await mkdir(join(file, '..'), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    execFile(
      'pg_dump',
      [
        '--dbname',
        url.toString(),
        '--format=custom',
        '--no-owner',
        '--file',
        file,
        ...existing.flatMap((table) => ['--table', qualified(table)]),
      ],
      {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          PGPASSWORD: password,
        } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
        timeout: 10 * 60_000,
      },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`pg_dump non riuscito: ${stderr.trim() || error.message}`));
        else resolve();
      },
    );
  });
  return true;
};

export interface HealthCheckOptions {
  /** Address of site-prod, e.g. `http://site-prod:3000/`. */
  url: string;
  /** Wait before the first probe, so the site can notice the new pointer and restart. */
  settleMs?: number;
  attempts?: number;
  intervalMs?: number;
  fetch?: typeof fetch;
}

/** HTTP health check of the production site: it must answer 200 within the attempts given. */
export function createHealthCheck(options: HealthCheckOptions): () => Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const attempts = options.attempts ?? 30;
  const interval = options.intervalMs ?? 2_000;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  return async () => {
    await sleep(options.settleMs ?? 3_000);
    let last = 'nessuna risposta';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await doFetch(options.url, {
          signal: AbortSignal.timeout(5_000),
          redirect: 'manual',
        });
        if (response.status >= 200 && response.status < 400) return;
        last = `risposta ${String(response.status)}`;
      } catch (error) {
        last = (error as Error).message;
      }
      if (attempt < attempts) await sleep(interval);
    }
    throw new Error(
      `Il sito di produzione non risponde dopo ${String(attempts)} tentativi (${last}).`,
    );
  };
}

/**
 * Releases an approved changeset to production (FR-50 … FR-59, TECHNICAL §8.4). One release
 * runs at a time (a global advisory lock; a second one waits and is retried by the queue):
 *
 * 1. rebase the branch on `main`; when `main` moved, the checks run again;
 * 2. build the artifact in `releases/<id>/`;
 * 3. `pg_dump` the tables the migrations touch, then apply them to `app_prod` in one
 *    transaction;
 * 4. switch `current` to the new artifact, restart `site-prod` and health check it — on
 *    failure the previous artifact is restored;
 * 5. fast-forward `main`, tag `release-<n>`, mark the release `released`, audit.
 *
 * Any error leaves the release `release_failed` with the reason. The migrations are additive
 * ("prima si aggiunge, poi si toglie"), so the previous artifact keeps working with the
 * migrated database; a destructive one is covered by the backup.
 */
export async function runRelease(
  db: Database,
  releaseId: string,
  options: ReleaseOptions,
): Promise<ReleaseOutcome> {
  const [release] = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.id, releaseId));
  if (!release) throw new ChangesetError(`Release ${releaseId} non trovata`);
  if (release.status !== 'pending' && release.status !== 'running') {
    return { status: 'skipped', releaseId, reason: `stato "${release.status}"` };
  }
  const changesetId = release.changesetIds[0];
  if (!changesetId) throw new ChangesetError(`La release ${releaseId} non ha changeset`);

  // The lock lives as long as this transaction; it does no other work.
  return db.transaction(async (lock) => {
    const rows = await lock.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext('release-run')) AS locked`,
    );
    if (!rows[0]?.locked) throw new ReleaseBusyError();
    return execute(db, releaseId, changesetId, options);
  });
}

async function execute(
  db: Database,
  releaseId: string,
  changesetId: string,
  options: ReleaseOptions,
): Promise<ReleaseOutcome> {
  const site = options.site ?? siteRepoPaths();
  const bare = bareRepoPath(site.gitRoot);
  const [release] = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.id, releaseId));
  if (!release) throw new ChangesetError(`Release ${releaseId} non trovata`);
  const tag = `release-${String(release.number)}`;
  const artifactPath = join(options.releasesRoot, releaseId);
  const startedAt = Date.now();

  let step: ReleaseStep = 'prepare';
  let activated: { previous: string | null } | null = null;
  let stagingMoved = false;
  const log: string[] = [];
  const say = (message: string) => log.push(message);

  await db
    .update(schema.releases)
    .set({ status: 'running', error: null })
    .where(eq(schema.releases.id, releaseId));

  try {
    const changeset = await loadChangeset(db, changesetId);
    if (changeset.status !== 'releasing') {
      throw new ReleaseError(
        'prepare',
        `Il changeset è nello stato "${changeset.status}", non "releasing".`,
      );
    }

    // 1. Rebase on main; run the checks again if main moved.
    const commit = await rebaseOnMain(
      db,
      changeset,
      release.number,
      site,
      options,
      (s) => (step = s),
      say,
    );
    await db.update(schema.releases).set({ commit }).where(eq(schema.releases.id, releaseId));

    // 2. Build the final artifact.
    step = 'build';
    try {
      await options.builder.buildRelease({ releaseId, changesetId, commit });
    } catch (error) {
      throw new ReleaseError(
        'build',
        `Build della release non riuscita: ${(error as Error).message}`,
      );
    }
    await db.update(schema.releases).set({ artifactPath }).where(eq(schema.releases.id, releaseId));
    say('build ok');

    // 3. Back up the touched tables, then migrate production in one transaction.
    const prodUrl = options.prodOwnerUrl();
    const migrations = await readSiteMigrations(bare, commit);
    const pending = await pendingSiteMigrations(prodUrl, migrations);
    if (pending.length > 0) {
      step = 'backup';
      const tables = [...new Set(pending.flatMap((m) => tablesTouchedBy(m.sql)))].sort();
      const destructive = pending.some((m) => findDestructiveStatements(m.sql).length > 0);
      if (tables.length > 0) {
        const file = join(
          options.backupsRoot,
          `release-${String(release.number)}-${releaseId}.dump`,
        );
        let dumped: boolean;
        try {
          dumped = await (options.dump ?? pgDumpTables)({ databaseUrl: prodUrl, tables, file });
        } catch (error) {
          throw new ReleaseError('backup', (error as Error).message);
        }
        if (dumped) {
          await db
            .update(schema.releases)
            .set({ backupPath: file })
            .where(eq(schema.releases.id, releaseId));
          say(`backup di ${tables.join(', ')}`);
        } else if (destructive) {
          throw new ReleaseError(
            'backup',
            'La migrazione distruttiva non ha tabelle da salvare: verifica lo schema.',
          );
        }
      }
      step = 'migrate';
      try {
        const result = await applySiteMigrations(prodUrl, migrations, { atomic: true });
        if (result.needsReset) {
          throw new Error(
            'Una migrazione già applicata in produzione è stata modificata: aggiungi una nuova migrazione invece di cambiarla.',
          );
        }
        say(`migrazioni: ${result.applied.join(', ') || 'nessuna'}`);
      } catch (error) {
        throw new ReleaseError('migrate', (error as Error).message);
      }
    }

    // 4. Switch the pointer, restart and check the site; the old artifact comes back on failure.
    step = 'activate';
    await mkdir(options.releasesRoot, { recursive: true });
    const previous = await readCurrentRelease(options.releasesRoot);
    if (!(await exists(artifactPath))) {
      throw new ReleaseError('activate', `L’artefatto ${artifactPath} non esiste.`);
    }
    await switchCurrentRelease(options.releasesRoot, releaseId);
    activated = { previous };
    await options.restart?.();
    step = 'health';
    try {
      await options.healthCheck?.();
    } catch (error) {
      throw new ReleaseError('health', (error as Error).message);
    }
    say('health check ok');

    // 5. Merge into main (fast-forward), tag, close.
    step = 'merge';
    const workspace = workspacePath(site, changesetId);
    const git = (args: string[], actor?: 'release' | 'changeset') =>
      runGit([...UNTRUSTED_REPO_CONFIG, ...args], {
        cwd: workspace,
        env: actor ? { CMS_GIT_ACTOR: actor } : undefined,
      });
    try {
      await git(['tag', '-f', tag, commit]);
      await git(
        [
          'push',
          '--quiet',
          '--no-verify',
          '--receive-pack=git-receive-pack',
          '--',
          bare,
          `${commit}:refs/heads/main`,
          `refs/tags/${tag}:refs/tags/${tag}`,
        ],
        'release',
      );
      const staging = await resolveRef(bare, 'refs/heads/staging');
      if (staging && staging !== commit && (await isAncestor(bare, staging, commit))) {
        await git(
          [
            'push',
            '--quiet',
            '--no-verify',
            '--receive-pack=git-receive-pack',
            '--',
            bare,
            `${commit}:refs/heads/staging`,
          ],
          'release',
        );
        stagingMoved = true;
      }
    } catch (error) {
      throw new ReleaseError('merge', `Merge su main non riuscito: ${(error as Error).message}`);
    }

    await db
      .update(schema.releases)
      .set({ status: 'released', finishedAt: new Date(), error: null })
      .where(eq(schema.releases.id, releaseId));
    await setChangesetStatus(db, changesetId, 'released', {
      actorUid: release.approvedBy,
      details: { releaseId, tag },
    });
    await writeAudit(db, {
      actorUid: release.approvedBy,
      action: 'release.deploy',
      env: 'prod',
      outcome: 'ok',
      details: {
        releaseId,
        number: release.number,
        tag,
        commit,
        changesetId,
        previousRelease: activated.previous,
        stagingMoved,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        log,
      },
    });
    return { status: 'released', releaseId, number: release.number, commit, tag };
  } catch (error) {
    const reason = error instanceof ReleaseError ? error : null;
    const message = (error as Error).message;
    if (activated) {
      // Back to the artifact that was serving before; the restart is best effort.
      try {
        await switchCurrentRelease(options.releasesRoot, activated.previous);
        await options.restart?.();
        log.push('artefatto precedente ripristinato');
      } catch (restoreError) {
        log.push(`ripristino non riuscito: ${(restoreError as Error).message}`);
      }
    }
    await db
      .update(schema.releases)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(schema.releases.id, releaseId));
    const changeset = await loadChangeset(db, changesetId).catch(() => null);
    if (changeset?.status === 'releasing') {
      await setChangesetStatus(db, changesetId, 'release_failed', {
        actorUid: release.approvedBy,
        details: { releaseId, step: reason?.step ?? step },
      });
    }
    await writeAudit(db, {
      actorUid: release.approvedBy,
      action: 'release.deploy',
      env: 'prod',
      outcome: 'error',
      details: {
        releaseId,
        number: release.number,
        changesetId,
        step: reason?.step ?? step,
        error: message,
        log,
      },
    });
    return { status: 'failed', releaseId, step: reason?.step ?? 'unknown', error: message };
  }
}

async function loadChangeset(db: Database, changesetId: string): Promise<Changeset> {
  const [row] = await db
    .select()
    .from(schema.changesets)
    .where(eq(schema.changesets.id, changesetId));
  if (!row) throw new ChangesetError(`Changeset ${changesetId} non trovato`);
  return row;
}

/**
 * Rebases `cs/<id>` on `main` in the changeset clone when `main` is not already an ancestor
 * of the branch; then the branch is pushed again and the checks run on the new commit.
 * Returns the commit to release.
 */
async function rebaseOnMain(
  db: Database,
  changeset: Changeset,
  releaseNumber: number,
  site: SiteRepoPaths,
  options: ReleaseOptions,
  setStep: (step: ReleaseStep) => void,
  say: (message: string) => void,
): Promise<string> {
  const bare = bareRepoPath(site.gitRoot);
  const head = changeset.headCommit;
  if (!head) throw new ReleaseError('prepare', 'Il changeset non ha un commit da pubblicare.');
  const main = await resolveRef(bare, 'refs/heads/main');
  if (!main) throw new ReleaseError('prepare', 'Il ramo main non esiste nel repository del sito.');
  if (await isAncestor(bare, main, head)) {
    say('main invariato: nessun rebase');
    return head;
  }

  setStep('rebase');
  const workspace = workspacePath(site, changeset.id);
  if (!(await exists(workspace))) {
    throw new ReleaseError(
      'rebase',
      'Il clone di lavoro del changeset non esiste più: riapri il changeset.',
    );
  }
  const git = (args: string[], actor?: 'changeset') =>
    runGit([...UNTRUSTED_REPO_CONFIG, ...args], {
      cwd: workspace,
      env: actor ? { CMS_GIT_ACTOR: actor } : undefined,
    });
  await git(['fetch', '--quiet', '--', bare, '+refs/heads/main:refs/remotes/origin/main']);
  await git(['checkout', '--quiet', changeset.branch]);
  try {
    await git(['rebase', '--quiet', 'refs/remotes/origin/main']);
  } catch (error) {
    await git(['rebase', '--abort']).catch(() => undefined);
    throw new ReleaseError(
      'rebase',
      `Il changeset è in conflitto con le ultime modifiche di main: ${(error as Error).message}`,
    );
  }
  const rebased = (await git(['rev-parse', 'HEAD'])).trim();
  const ref = `refs/heads/${changeset.branch}`;
  await git(
    [
      'push',
      '--quiet',
      '--no-verify',
      '--force',
      '--receive-pack=git-receive-pack',
      '--',
      bare,
      `${ref}:${ref}`,
    ],
    'changeset',
  );
  await db
    .update(schema.changesets)
    .set({ headCommit: rebased, baseCommit: main, updatedAt: new Date() })
    .where(eq(schema.changesets.id, changeset.id));
  say(`rebase su main ${main.slice(0, 7)}: ${head.slice(0, 7)} → ${rebased.slice(0, 7)}`);

  // Main moved since the last check: the release waits for the checks on the new commit.
  setStep('checks');
  await setChangesetStatus(db, changeset.id, 'checking', {
    actorUid: changeset.authorUid,
    details: { reason: 'main è cambiato durante la release', releaseNumber },
  });
  const rerun =
    options.rerunChecks ??
    (async (id: string) => {
      if (!options.checks) throw new Error('Opzioni dei controlli mancanti');
      return (await runChangesetChecks(db, id, options.checks)).status;
    });
  const status = await rerun(changeset.id);
  if (status !== 'ready') {
    throw new ReleaseError(
      'checks',
      'I controlli sono falliti dopo il rebase su main: correggi il changeset e approvalo di nuovo.',
    );
  }
  await setChangesetStatus(db, changeset.id, 'releasing', { actorUid: changeset.authorUid });
  say('controlli rieseguiti: ok');
  return rebased;
}
