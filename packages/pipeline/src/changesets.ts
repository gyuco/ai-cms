import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAudit } from '@ai-cms/audit';
import { schema, type Database } from '@ai-cms/db';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { runGit } from './git.ts';
import { bareRepoPath, resolveRef, siteRepoPaths, type SiteRepoPaths } from './site-repo.ts';
import { pathsOverlap, touchedTreePaths } from './tree-paths.ts';

export type Changeset = typeof schema.changesets.$inferSelect;
export type ChangesetStatus = Changeset['status'];

export class ChangesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangesetError';
  }
}

/** Statuses of a changeset that is still being worked on or released. */
export const openChangesetStatuses: readonly ChangesetStatus[] = [
  'draft',
  'checking',
  'checks_failed',
  'ready',
  'releasing',
];

/** Statuses in which the agent may still add work to the branch. */
const editableStatuses: readonly ChangesetStatus[] = ['draft', 'checks_failed'];

/**
 * TECHNICAL §8.1, plus closing an abandoned changeset. A rejection with a comment brings a
 * ready changeset back to draft; `rejected` is not used by the state machine.
 */
const transitions: Record<ChangesetStatus, readonly ChangesetStatus[]> = {
  draft: ['checking', 'closed'],
  checking: ['checks_failed', 'ready'],
  checks_failed: ['checking', 'closed'],
  ready: ['releasing', 'draft', 'closed'],
  // `checking`: main moved during the release, so the checks run again on the rebased branch.
  releasing: ['released', 'release_failed', 'checking'],
  release_failed: ['draft', 'closed'],
  released: ['rolled_back'],
  rejected: ['draft', 'closed'],
  rolled_back: [],
  closed: [],
};

export function canTransition(from: ChangesetStatus, to: ChangesetStatus): boolean {
  return transitions[from].includes(to);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The working clone of a changeset: `<workspacesRoot>/<id>`. */
export function workspacePath(paths: SiteRepoPaths, changesetId: string): string {
  if (!UUID.test(changesetId))
    throw new ChangesetError(`Id di changeset non valido: ${changesetId}`);
  return join(paths.workspacesRoot, changesetId);
}

async function getChangeset(db: Database, changesetId: string): Promise<Changeset> {
  if (!UUID.test(changesetId))
    throw new ChangesetError(`Id di changeset non valido: ${changesetId}`);
  const [row] = await db
    .select()
    .from(schema.changesets)
    .where(eq(schema.changesets.id, changesetId));
  if (!row) throw new ChangesetError(`Changeset ${changesetId} non trovato`);
  return row;
}

export interface CreateChangesetInput {
  title: string;
  description?: string | null;
  authorUid: number;
  conversationId?: string | null;
}

/**
 * Starts a changeset from the head of `staging`: a `draft` row and a working clone on the
 * branch `cs/<id>`, where the developer agent works and commits.
 */
export async function createChangeset(
  db: Database,
  input: CreateChangesetInput,
  paths: SiteRepoPaths = siteRepoPaths(),
): Promise<Changeset> {
  const id = randomUUID();
  const branch = `cs/${id}`;
  const bare = bareRepoPath(paths.gitRoot);
  const baseCommit = await resolveRef(bare, 'refs/heads/staging');
  if (!baseCommit) throw new ChangesetError('Il repository del sito non è ancora inizializzato');

  const workspace = workspacePath(paths, id);
  await mkdir(paths.workspacesRoot, { recursive: true });
  try {
    await runGit(['clone', '--quiet', '--branch', 'staging', '--', bare, workspace]);
    await runGit(['checkout', '--quiet', '-b', branch, baseCommit], { cwd: workspace });
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.changesets)
        .values({
          id,
          title: input.title,
          description: input.description ?? null,
          branch,
          baseCommit,
          authorUid: input.authorUid,
          conversationId: input.conversationId ?? null,
        })
        .returning();
      await writeAudit(tx, {
        actorUid: input.authorUid,
        action: 'changeset.create',
        env: 'staging',
        outcome: 'ok',
        details: { changesetId: id, title: input.title, branch, baseCommit },
      });
      return row!;
    });
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The working clone is written by the agent, so its git config and hooks are untrusted:
 * these overrides keep a push from running anything the agent could have configured.
 */
export const UNTRUSTED_REPO_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.file.allow=always',
  '-c',
  'push.gpgSign=false',
  '-c',
  'push.recurseSubmodules=no',
];

export interface RecordWorkResult {
  headCommit: string;
  changedFiles: string[];
  touchedPaths: string[];
}

/**
 * Pushes the changeset branch from its working clone to site.git (actor `changeset`), then
 * records the head commit and the tree paths touched since the base commit.
 */
export async function recordWork(
  db: Database,
  changesetId: string,
  paths: SiteRepoPaths = siteRepoPaths(),
): Promise<RecordWorkResult> {
  const changeset = await getChangeset(db, changesetId);
  if (!editableStatuses.includes(changeset.status)) {
    throw new ChangesetError(
      `Il changeset è nello stato "${changeset.status}": non si possono registrare modifiche`,
    );
  }
  const bare = bareRepoPath(paths.gitRoot);
  const ref = `refs/heads/${changeset.branch}`;
  await runGit(
    [
      ...UNTRUSTED_REPO_CONFIG,
      'push',
      '--quiet',
      '--no-verify',
      '--receive-pack=git-receive-pack',
      '--',
      bare,
      `${ref}:${ref}`,
    ],
    { cwd: workspacePath(paths, changesetId), env: { CMS_GIT_ACTOR: 'changeset' } },
  );

  const headCommit = await resolveRef(bare, ref);
  if (!headCommit) throw new ChangesetError(`Ramo ${changeset.branch} non trovato dopo il push`);
  const diff = await runGit(
    [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      changeset.baseCommit,
      headCommit,
      '--',
    ],
    { cwd: bare },
  );
  const changedFiles = diff.split('\0').filter(Boolean);
  const touchedPaths = touchedTreePaths(changedFiles);

  await db.transaction(async (tx) => {
    await tx
      .update(schema.changesets)
      .set({
        headCommit,
        touchedPaths,
        updatedAt: new Date(),
      })
      .where(eq(schema.changesets.id, changesetId));
    await writeAudit(tx, {
      actorUid: changeset.authorUid,
      action: 'changeset.record',
      env: 'staging',
      outcome: 'ok',
      details: { changesetId, headCommit, files: changedFiles.length, touchedPaths },
    });
  });
  return { headCommit, changedFiles, touchedPaths };
}

export interface SetStatusOptions {
  /** Who caused the change; defaults to the changeset author. */
  actorUid?: number;
  details?: Record<string, unknown>;
}

/** Moves a changeset to a new status, refusing transitions not allowed by §8.1. */
export async function setChangesetStatus(
  db: Database,
  changesetId: string,
  to: ChangesetStatus,
  options: SetStatusOptions = {},
): Promise<Changeset> {
  if (!UUID.test(changesetId))
    throw new ChangesetError(`Id di changeset non valido: ${changesetId}`);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.changesets)
      .where(eq(schema.changesets.id, changesetId))
      .for('update');
    if (!current) throw new ChangesetError(`Changeset ${changesetId} non trovato`);
    if (!canTransition(current.status, to)) {
      throw new ChangesetError(
        `Transizione non consentita per il changeset: da "${current.status}" a "${to}"`,
      );
    }
    const [row] = await tx
      .update(schema.changesets)
      .set({ status: to, updatedAt: new Date() })
      .where(eq(schema.changesets.id, changesetId))
      .returning();
    await writeAudit(tx, {
      actorUid: options.actorUid ?? current.authorUid,
      action: 'changeset.status',
      env: 'staging',
      outcome: 'ok',
      details: { changesetId, from: current.status, to, ...options.details },
    });
    return row!;
  });
}

export interface ChangesetConflict {
  changesetId: string;
  title: string;
  authorUid: number;
  status: ChangesetStatus;
  /** Paths of the other changeset that overlap with this one. */
  paths: string[];
}

/** Other open changesets touching the same tree paths, or their ancestors or descendants. */
export async function findConflicts(
  db: Database,
  changesetId: string,
): Promise<ChangesetConflict[]> {
  const changeset = await getChangeset(db, changesetId);
  if (changeset.touchedPaths.length === 0) return [];
  const others = await db
    .select()
    .from(schema.changesets)
    .where(
      and(
        ne(schema.changesets.id, changesetId),
        inArray(schema.changesets.status, [...openChangesetStatuses]),
      ),
    );
  const conflicts: ChangesetConflict[] = [];
  for (const other of others) {
    const paths = other.touchedPaths.filter((p) =>
      changeset.touchedPaths.some((mine) => pathsOverlap(p, mine)),
    );
    if (paths.length > 0) {
      conflicts.push({
        changesetId: other.id,
        title: other.title,
        authorUid: other.authorUid,
        status: other.status,
        paths,
      });
    }
  }
  return conflicts.sort((a, b) => a.changesetId.localeCompare(b.changesetId));
}

/**
 * Closes a changeset: marks an unfinished one `closed` and removes its working clone. The
 * branch stays in site.git for history. Refused while checks or a release are running.
 */
export async function closeChangeset(
  db: Database,
  changesetId: string,
  paths: SiteRepoPaths = siteRepoPaths(),
  options: SetStatusOptions = {},
): Promise<Changeset> {
  let changeset = await getChangeset(db, changesetId);
  const finished: readonly ChangesetStatus[] = ['released', 'rolled_back', 'closed'];
  if (!finished.includes(changeset.status)) {
    changeset = await setChangesetStatus(db, changesetId, 'closed', options);
  }
  await rm(workspacePath(paths, changesetId), { recursive: true, force: true });
  await writeAudit(db, {
    actorUid: options.actorUid ?? changeset.authorUid,
    action: 'changeset.close',
    env: 'staging',
    outcome: 'ok',
    details: { changesetId, status: changeset.status },
  });
  return changeset;
}
