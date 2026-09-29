import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAudit } from '@ai-cms/audit';
import { schema, type Database } from '@ai-cms/db';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { ChangesetError, setChangesetStatus } from './changesets.ts';
import { enqueue } from './queue.ts';
import {
  readCurrentRelease,
  ReleaseBusyError,
  switchCurrentRelease,
  type ReleaseOptions,
} from './release.ts';

/** Job that puts the previous release back in front of the site (TECHNICAL §8.5). */
export const ROLLBACK_JOB = 'release.rollback';

/** Attempts of the rollback job: like a release, it only waits for the global lock. */
export const ROLLBACK_JOB_ATTEMPTS = 30;

export function rollbackDedupeKey(releaseId: string): string {
  return `rollback:${releaseId}`;
}

type Release = typeof schema.releases.$inferSelect;

/** The release a rollback of `release` returns to: the last successful one before it. */
async function previousReleased(db: Database, release: Release): Promise<Release | null> {
  const [previous] = await db
    .select()
    .from(schema.releases)
    .where(and(eq(schema.releases.status, 'released'), lt(schema.releases.number, release.number)))
    .orderBy(desc(schema.releases.number))
    .limit(1);
  return previous ?? null;
}

/** The release production is serving according to the database: the newest successful one. */
export async function latestReleased(db: Database): Promise<Release | null> {
  const [latest] = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.status, 'released'))
    .orderBy(desc(schema.releases.number))
    .limit(1);
  return latest ?? null;
}

export interface RollbackRequest {
  /** The release to undo: it must be the one production is serving. */
  releaseId: string;
  /** The user who asks. In phase 1 every authenticated user may roll back. */
  actorUid: number;
}

export interface RollbackRequested {
  releaseId: string;
  releaseNumber: number;
  /** The release production goes back to. */
  toReleaseId: string;
  toReleaseNumber: number;
}

/**
 * Asks for a rollback of the release in production and queues the job (FR-53). Only the newest
 * successful release can be undone, and only when an earlier one exists. The database is never
 * restored: migrations follow "first add, then remove", so the previous artifact still works on
 * the current schema.
 */
export async function requestRollback(
  db: Database,
  input: RollbackRequest,
): Promise<RollbackRequested> {
  const [release] = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.id, input.releaseId));
  if (!release) throw new ChangesetError(`Release ${input.releaseId} non trovata`);
  if (release.status !== 'released') {
    throw new ChangesetError(
      `Si può annullare solo una release pubblicata: la release ${String(release.number)} è "${release.status}".`,
    );
  }
  const latest = await latestReleased(db);
  if (latest?.id !== release.id) {
    throw new ChangesetError(
      `Si può tornare indietro solo dall’ultima release pubblicata (${String(latest?.number ?? '?')}).`,
    );
  }
  const previous = await previousReleased(db, release);
  if (!previous) {
    throw new ChangesetError(
      `Non esiste una release precedente alla ${String(release.number)} a cui tornare.`,
    );
  }
  await writeAudit(db, {
    actorUid: input.actorUid,
    action: 'release.rollback.request',
    env: 'prod',
    outcome: 'ok',
    details: { releaseId: release.id, number: release.number, toReleaseId: previous.id },
  });
  await enqueue(
    db,
    ROLLBACK_JOB,
    { releaseId: release.id, actorUid: input.actorUid },
    { dedupeKey: rollbackDedupeKey(release.id), maxAttempts: ROLLBACK_JOB_ATTEMPTS },
  );
  return {
    releaseId: release.id,
    releaseNumber: release.number,
    toReleaseId: previous.id,
    toReleaseNumber: previous.number,
  };
}

export type RollbackOptions = Pick<ReleaseOptions, 'releasesRoot' | 'restart' | 'healthCheck'>;

export type RollbackOutcome =
  | { status: 'rolled_back'; releaseId: string; number: number; toReleaseId: string }
  | { status: 'failed'; releaseId: string; error: string }
  | { status: 'skipped'; releaseId: string; reason: string };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the rollback: points `current` at the previous release, restarts and health checks
 * `site-prod` (the pointer goes back if it does not answer), then marks the release and its
 * changesets `rolled_back`. It shares the global lock of the release job, so it never runs
 * while a release does. `main` and the tags are left alone: the history stays as it happened.
 */
export async function runRollback(
  db: Database,
  releaseId: string,
  actorUid: number,
  options: RollbackOptions,
): Promise<RollbackOutcome> {
  const [release] = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.id, releaseId));
  if (!release) throw new ChangesetError(`Release ${releaseId} non trovata`);
  if (release.status !== 'released') {
    return { status: 'skipped', releaseId, reason: `stato "${release.status}"` };
  }
  return db.transaction(async (lock) => {
    const rows = await lock.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext('release-run')) AS locked`,
    );
    if (!rows[0]?.locked) throw new ReleaseBusyError();
    return rollBack(db, release, actorUid, options);
  });
}

async function rollBack(
  db: Database,
  release: Release,
  actorUid: number,
  options: RollbackOptions,
): Promise<RollbackOutcome> {
  const startedAt = Date.now();
  const previous = await previousReleased(db, release);
  const before = await readCurrentRelease(options.releasesRoot);
  let switched = false;

  const fail = async (message: string): Promise<RollbackOutcome> => {
    await writeAudit(db, {
      actorUid,
      action: 'release.rollback',
      env: 'prod',
      outcome: 'error',
      details: { releaseId: release.id, number: release.number, error: message },
    });
    return { status: 'failed', releaseId: release.id, error: message };
  };

  if (!previous) return fail(`Non esiste una release precedente alla ${String(release.number)}.`);
  const artifact = join(options.releasesRoot, previous.id);
  if (!(await exists(artifact))) {
    return fail(
      `L’artefatto della release ${String(previous.number)} non esiste più (${artifact}).`,
    );
  }
  try {
    await switchCurrentRelease(options.releasesRoot, previous.id);
    switched = true;
    await options.restart?.();
    await options.healthCheck?.();
  } catch (error) {
    if (switched) {
      // Best effort: the release that was serving comes back.
      try {
        await switchCurrentRelease(options.releasesRoot, before);
        await options.restart?.();
      } catch {
        // The original error is the one worth reporting.
      }
    }
    return fail(
      `Il sito non risponde sulla release ${String(previous.number)}: ${(error as Error).message}`,
    );
  }

  await db
    .update(schema.releases)
    .set({ status: 'rolled_back', finishedAt: new Date() })
    .where(eq(schema.releases.id, release.id));
  for (const changesetId of release.changesetIds) {
    await setChangesetStatus(db, changesetId, 'rolled_back', {
      actorUid,
      details: { releaseId: release.id },
    }).catch(() => undefined);
  }
  await writeAudit(db, {
    actorUid,
    action: 'release.rollback',
    env: 'prod',
    outcome: 'ok',
    details: {
      releaseId: release.id,
      number: release.number,
      toReleaseId: previous.id,
      toNumber: previous.number,
      changesetIds: release.changesetIds,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    },
  });
  return {
    status: 'rolled_back',
    releaseId: release.id,
    number: release.number,
    toReleaseId: previous.id,
  };
}
