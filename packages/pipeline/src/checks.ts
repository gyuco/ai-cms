import { writeAudit } from '@ai-cms/audit';
import { authorize, devAgentProfile, fromLtree, type Principal } from '@ai-cms/authz';
import { schema, type Database } from '@ai-cms/db';
import { and, eq, sql } from 'drizzle-orm';
import type { BuilderClient } from './builder-client.ts';
import {
  BUILDER_CHECKS,
  CHECK_NAMES,
  summarizeChecks,
  truncateOutput,
  type BuilderRun,
  type CheckName,
  type CheckResult,
  type CheckStatus,
} from './builder-protocol.ts';
import {
  changesetDatabaseName,
  createChangesetDatabase,
  dropChangesetDatabase,
} from './changeset-db.ts';
import {
  ChangesetError,
  recordWork,
  setChangesetStatus,
  type Changeset,
  type ChangesetStatus,
} from './changesets.ts';
import { runGit } from './git.ts';
import {
  applySiteMigrations,
  findDestructiveStatements,
  MigrationError,
  readSiteMigrations,
} from './migrations.ts';
import { bareRepoPath, siteRepoPaths, type SiteRepoPaths } from './site-repo.ts';

type Outcome = Pick<CheckResult, 'status' | 'output'>;

/**
 * `permissions` check (TECHNICAL §8.2, 1): every tree path touched by the changeset must be
 * writable by its author through the developer agent profile, in staging. Re-evaluated on the
 * server whatever the agent was allowed to do while working.
 */
export function permissionsCheck(
  author: Pick<Principal, 'uid' | 'username' | 'status'>,
  touchedPaths: readonly string[],
): Outcome {
  if (touchedPaths.length === 0) {
    return { status: 'passed', output: 'Nessun file modificato.' };
  }
  const principal: Principal = { ...author, agent: devAgentProfile };
  const denied: string[] = [];
  const allowed: string[] = [];
  for (const path of touchedPaths) {
    const decision = authorize(
      principal,
      'write',
      { path, kind: 'file', storage: 'git' },
      'staging',
    );
    if (decision.allowed) allowed.push(`- ${fromLtree(path)}`);
    else denied.push(`- ${fromLtree(path)}: ${decision.message}`);
  }
  if (denied.length > 0) {
    return {
      status: 'failed',
      output: [
        `Il changeset modifica percorsi non consentiti a ${author.username} tramite l'agente sviluppatore:`,
        ...denied,
        'Annulla le modifiche a questi file.',
      ].join('\n'),
    };
  }
  return {
    status: 'passed',
    output: ['Percorsi modificati, tutti consentiti:', ...allowed].join('\n'),
  };
}

/**
 * URL paths of the pages a set of changed files defines (Next.js App Router conventions).
 * Route groups and parallel-route slots do not appear in the URL; dynamic segments cannot be
 * requested without data, so those pages are left out.
 */
export function pageUrlsForFiles(files: readonly string[]): string[] {
  const urls = new Set<string>();
  for (const file of files) {
    const match = /^app\/(?:(.*)\/)?page\.(?:tsx|ts|jsx|js|mdx)$/.exec(file);
    if (!match) continue;
    const segments = (match[1] ?? '').split('/').filter(Boolean);
    if (segments.some((s) => s.startsWith('[') || s.startsWith('_'))) continue;
    const visible = segments.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
    urls.add(`/${visible.map(encodeURIComponent).join('/')}`);
  }
  return [...urls].sort();
}

/** `site.pages.index` → `/`, `site.pages.blog.index` → `/blog`, `site.pages.chi-siamo` → `/chi-siamo`. */
export function pageUrlForTreePath(path: string): string | null {
  const labels = path.split('.');
  if (labels[0] !== 'site' || labels[1] !== 'pages') return null;
  const rest = labels.slice(2);
  if (rest.at(-1) === 'index') rest.pop();
  return `/${rest.join('/')}`;
}

/** URL paths of the pages published in staging, which must all answer 200 (`e2e`). */
export async function publishedPageUrls(db: Database): Promise<string[]> {
  const rows = await db.execute<{ path: string }>(sql`
    SELECT path::text AS path FROM published_content
    WHERE env = 'staging' AND kind = 'page' AND path <@ 'site.pages'`);
  const urls = rows.map((row) => pageUrlForTreePath(row.path)).filter((u) => u !== null);
  return [...new Set(urls)].sort();
}

export interface RunChecksOptions {
  site?: SiteRepoPaths;
  builder: BuilderClient;
  /** `site_app` connection to a database of the staging server; handed to the builder. */
  appDatabaseUrl: (database: string) => string;
  /** `app_owner` connection to a database of the staging server; used only by the worker. */
  ownerDatabaseUrl: (database: string) => string;
  /** `app_owner` connection to a database other than the template, to recreate the clone. */
  stagingAdminUrl: () => string;
  stagingTemplate?: string;
  /** Defaults to the pages published in staging. */
  publishedPages?: () => Promise<string[]>;
  pollIntervalMs?: number;
  /** Maximum wait for the builder run. */
  timeoutMs?: number;
  /** Called after every check_runs update (tests, live status). */
  onUpdate?: (result: CheckResult) => void;
}

export interface RunChecksResult {
  commit: string;
  status: Extract<ChangesetStatus, 'ready' | 'checks_failed'>;
  checks: CheckResult[];
  destructiveMigration: boolean;
}

async function changedFiles(bare: string, from: string, to: string): Promise<string[]> {
  const out = await runGit(
    ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', from, to, '--'],
    { cwd: bare },
  );
  return out.split('\0').filter(Boolean);
}

/**
 * The `changeset.check` job: records the agent's work, moves the changeset to `checking`, runs
 * every check of TECHNICAL §8.2 (permissions and migration here, the rest in the builder),
 * stores each result in `check_runs` as it arrives, and ends in `ready` or `checks_failed`.
 * A retry of a job interrupted while `checking` re-runs the checks of the same commit.
 */
export async function runChangesetChecks(
  db: Database,
  changesetId: string,
  options: RunChecksOptions,
): Promise<RunChecksResult> {
  const site = options.site ?? siteRepoPaths();
  const bare = bareRepoPath(site.gitRoot);
  const load = async () => {
    const [row] = await db
      .select()
      .from(schema.changesets)
      .where(eq(schema.changesets.id, changesetId));
    if (!row) throw new ChangesetError(`Changeset ${changesetId} non trovato`);
    return row;
  };

  let changeset: Changeset = await load();
  let files: string[];
  if (changeset.status === 'draft' || changeset.status === 'checks_failed') {
    files = (await recordWork(db, changesetId, site)).changedFiles;
    changeset = await setChangesetStatus(db, changesetId, 'checking');
  } else if (changeset.status === 'checking' && changeset.headCommit) {
    files = await changedFiles(bare, changeset.baseCommit, changeset.headCommit);
  } else {
    throw new ChangesetError(
      `Il changeset è nello stato "${changeset.status}": non si possono eseguire i controlli`,
    );
  }
  const commit = changeset.headCommit!;

  // A retried job replaces the results of the interrupted attempt on the same commit.
  await db
    .delete(schema.checkRuns)
    .where(and(eq(schema.checkRuns.changesetId, changesetId), eq(schema.checkRuns.commit, commit)));
  const inserted = await db
    .insert(schema.checkRuns)
    .values(CHECK_NAMES.map((checkName) => ({ changesetId, commit, checkName })))
    .returning({ id: schema.checkRuns.id, checkName: schema.checkRuns.checkName });
  const rowIds = new Map(inserted.map((r) => [r.checkName as CheckName, r.id]));
  const results = new Map<CheckName, CheckResult>(
    CHECK_NAMES.map((name) => [name, { name, status: 'queued', output: null }]),
  );

  const save = async (name: CheckName, patch: Partial<CheckResult>) => {
    const previous = results.get(name)!;
    const now = new Date().toISOString();
    const next: CheckResult = { ...previous, ...patch, name };
    if (next.output !== null) next.output = truncateOutput(next.output);
    if (next.status === 'running' && !next.startedAt) next.startedAt = now;
    if (['passed', 'failed', 'skipped'].includes(next.status) && !next.finishedAt) {
      next.finishedAt = now;
      next.startedAt ??= now;
    }
    results.set(name, next);
    await db
      .update(schema.checkRuns)
      .set({
        status: next.status,
        output: next.output,
        startedAt: next.startedAt ? new Date(next.startedAt) : null,
        finishedAt: next.finishedAt ? new Date(next.finishedAt) : null,
      })
      .where(eq(schema.checkRuns.id, rowIds.get(name)!));
    options.onUpdate?.(next);
  };
  const skipRemaining = async (reason: string) => {
    for (const [name, result] of results) {
      if (result.status === 'queued' || result.status === 'running') {
        await save(name, { status: 'skipped', output: reason });
      }
    }
  };

  // 1. permissions
  await save('permissions', { status: 'running' });
  const [author] = await db
    .select({
      uid: schema.users.uid,
      username: schema.users.username,
      status: schema.users.status,
    })
    .from(schema.users)
    .where(eq(schema.users.uid, changeset.authorUid));
  if (!author) throw new ChangesetError(`Autore ${String(changeset.authorUid)} non trovato`);
  const permissions = permissionsCheck(author, changeset.touchedPaths);
  await save('permissions', permissions);

  let destructive = false;
  if (permissions.status === 'failed') {
    await skipRemaining('Non eseguito: il controllo dei permessi è fallito.');
  } else {
    // 6. migration, before the builder: html and e2e run the site against the migrated DB.
    await save('migration', { status: 'running' });
    const migration = await migrationCheck(changeset, commit, bare, options);
    destructive = migration.destructive;
    await save('migration', migration);
    await runBuilderChecks(db, changesetId, commit, files, options, results, save);
  }

  await db
    .update(schema.changesets)
    .set({ destructiveMigration: destructive, updatedAt: new Date() })
    .where(eq(schema.changesets.id, changesetId));

  const checks = CHECK_NAMES.map((name) => results.get(name)!);
  const summary = summarizeChecks(checks);
  const status = summary.ok ? 'ready' : 'checks_failed';
  await setChangesetStatus(db, changesetId, status, {
    details: { commit, failed: summary.failed },
  });
  await writeAudit(db, {
    actorUid: changeset.authorUid,
    action: 'changeset.checks',
    env: 'staging',
    outcome: summary.ok ? 'ok' : 'error',
    details: {
      changesetId,
      commit,
      destructiveMigration: destructive,
      results: Object.fromEntries(checks.map((c) => [c.name, c.status])),
    },
  });
  return { commit, status, checks, destructiveMigration: destructive };
}

async function migrationCheck(
  changeset: Changeset,
  commit: string,
  bare: string,
  options: RunChecksOptions,
): Promise<Outcome & { destructive: boolean }> {
  const migrations = await readSiteMigrations(bare, commit);
  if (migrations.length === 0) {
    return {
      status: 'skipped',
      output: 'Nessuna migrazione in db/migrations.',
      destructive: false,
    };
  }
  const base = new Map(
    (await readSiteMigrations(bare, changeset.baseCommit)).map((m) => [m.name, m.blob]),
  );
  const changed = migrations.filter((m) => base.get(m.name) !== m.blob);
  const warnings = changed.flatMap((m) =>
    findDestructiveStatements(m.sql).map((f) => `- ${m.name}: ${f.reason}.\n    ${f.statement}`),
  );

  const database = changesetDatabaseName(changeset.id);
  const url = options.ownerDatabaseUrl(database);
  const lines: string[] = [];
  try {
    let result = await applySiteMigrations(url, migrations, { baseline: [...base.keys()] });
    if (result.needsReset) {
      // The clone is disposable: an edited migration is simpler to replay from scratch.
      await dropChangesetDatabase(options.stagingAdminUrl(), changeset.id);
      await createChangesetDatabase(options.stagingAdminUrl(), changeset.id, {
        template: options.stagingTemplate,
      });
      lines.push(
        'Una migrazione già applicata è cambiata: il database del changeset è stato ricreato da staging.',
      );
      result = await applySiteMigrations(url, migrations, { baseline: [...base.keys()] });
    }
    lines.push(
      result.applied.length > 0
        ? `Migrazioni applicate a ${database}: ${result.applied.join(', ')}.`
        : `Nessuna migrazione nuova da applicare a ${database}.`,
    );
  } catch (error) {
    const message = error instanceof MigrationError ? error.message : (error as Error).message;
    return {
      status: 'failed',
      output: [...lines, message].join('\n'),
      destructive: warnings.length > 0,
    };
  }
  if (warnings.length > 0) {
    lines.push(
      '',
      'Attenzione: migrazione distruttiva. Prima di pubblicare servirà una conferma esplicita e verrà fatto un backup.',
      'Regola: prima si aggiunge, poi si toglie (le rimozioni vanno in una release successiva).',
      ...warnings,
    );
  }
  return { status: 'passed', output: lines.join('\n'), destructive: warnings.length > 0 };
}

async function runBuilderChecks(
  db: Database,
  changesetId: string,
  commit: string,
  files: string[],
  options: RunChecksOptions,
  results: Map<CheckName, CheckResult>,
  save: (name: CheckName, patch: Partial<CheckResult>) => Promise<void>,
) {
  const builderChecks = BUILDER_CHECKS.filter((name) => results.get(name)!.status === 'queued');
  const same = (a: CheckResult, b: CheckResult) => a.status === b.status && a.output === b.output;
  const apply = async (run: BuilderRun) => {
    for (const check of run.checks) {
      if (!builderChecks.includes(check.name as (typeof builderChecks)[number])) continue;
      const current = results.get(check.name)!;
      if (!same(current, check)) {
        await save(check.name, {
          status: check.status,
          output: check.output,
          startedAt: check.startedAt ?? null,
          finishedAt: check.finishedAt ?? null,
        });
      }
    }
  };

  try {
    const pages = [...new Set(['/', ...pageUrlsForFiles(files)])].sort();
    const publishedPages = await (options.publishedPages ?? (() => publishedPageUrls(db)))();
    let run = await options.builder.startRun({
      changesetId,
      commit,
      databaseUrl: options.appDatabaseUrl(changesetDatabaseName(changesetId)),
      checks: builderChecks,
      pages,
      publishedPages: publishedPages.length > 0 ? publishedPages : ['/'],
    });
    const deadline = Date.now() + (options.timeoutMs ?? 45 * 60_000);
    await apply(run);
    while (run.status !== 'finished') {
      if (Date.now() > deadline) throw new Error('tempo massimo superato');
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 1_000));
      run = await options.builder.getRun(run.id);
      await apply(run);
    }
  } catch (error) {
    for (const name of builderChecks) {
      const status: CheckStatus = results.get(name)!.status;
      if (status === 'queued' || status === 'running') {
        await save(name, {
          status: 'failed',
          output: `Controllo non completato: errore del builder (${(error as Error).message}). Riprova più tardi.`,
        });
      }
    }
  }
}
