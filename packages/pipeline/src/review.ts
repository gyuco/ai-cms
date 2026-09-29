import { writeAudit } from '@ai-cms/audit';
import { schema, type Database } from '@ai-cms/db';
import { desc, eq, sql } from 'drizzle-orm';
import { isChangesetId } from './builder-protocol.ts';
import { ChangesetError, type Changeset } from './changesets.ts';
import { enqueue } from './queue.ts';

/** Job that runs the release of an approved changeset (TECHNICAL §8.4). */
export const RELEASE_JOB = 'release.run';

/** Job that hands the comment of a rejection to the developer agent (FR-43 request changes). */
export const REVISE_JOB = 'changeset.revise';

export function releaseDedupeKey(releaseId: string): string {
  return `release:${releaseId}`;
}

export function reviseDedupeKey(changesetId: string): string {
  return `revise:${changesetId}`;
}

/** Attempts of the release job: only the lock being taken by another release is retried. */
export const RELEASE_JOB_ATTEMPTS = 8;

export interface ApproveInput {
  changesetId: string;
  /** The approving user. In phase 1 every authenticated user may approve. */
  reviewerUid: number;
  /** Required when the changeset has a destructive migration (TECHNICAL §8.2, check 6). */
  confirmDestructive?: boolean;
  comment?: string | null;
}

export interface ApproveResult {
  releaseId: string;
  releaseNumber: number;
  changeset: Changeset;
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

async function loadChangesetForUpdate(tx: Tx, changesetId: string): Promise<Changeset> {
  if (!isChangesetId(changesetId)) {
    throw new ChangesetError(`Id di changeset non valido: ${changesetId}`);
  }
  const [row] = await tx
    .select()
    .from(schema.changesets)
    .where(eq(schema.changesets.id, changesetId))
    .for('update');
  if (!row) throw new ChangesetError(`Changeset ${changesetId} non trovato`);
  return row;
}

/**
 * "Approva e pubblica" (FR-51): records the approval, creates the release and moves the
 * changeset to `releasing`; the `release.run` job then does the work. Only a `ready` changeset
 * can be approved, and one with a destructive migration needs an explicit confirmation.
 * The separation of duties (FR-52) is off by default and arrives with the capabilities.
 */
export async function approveChangeset(db: Database, input: ApproveInput): Promise<ApproveResult> {
  const result = await db.transaction(async (tx) => {
    const changeset = await loadChangesetForUpdate(tx, input.changesetId);
    if (changeset.status !== 'ready') {
      throw new ChangesetError(
        `Il changeset è nello stato "${changeset.status}": si può approvare solo dopo che i controlli sono passati.`,
      );
    }
    if (!changeset.headCommit) {
      throw new ChangesetError('Il changeset non ha ancora un commit da pubblicare.');
    }
    if (changeset.destructiveMigration && input.confirmDestructive !== true) {
      throw new ChangesetError(
        'Il changeset contiene una migrazione distruttiva: serve una conferma esplicita per pubblicarlo.',
      );
    }
    // One number series for every release, whatever the changeset.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('release-number'))`);
    const [last] = await tx
      .select({ number: schema.releases.number })
      .from(schema.releases)
      .orderBy(desc(schema.releases.number))
      .limit(1);
    const [previous] = await tx
      .select({ id: schema.releases.id })
      .from(schema.releases)
      .where(eq(schema.releases.status, 'released'))
      .orderBy(desc(schema.releases.number))
      .limit(1);
    const number = (last?.number ?? -1) + 1;
    const [release] = await tx
      .insert(schema.releases)
      .values({
        number,
        changesetIds: [changeset.id],
        commit: changeset.headCommit,
        approvedBy: input.reviewerUid,
        previousReleaseId: previous?.id ?? null,
      })
      .returning();
    await tx.insert(schema.reviews).values({
      changesetId: changeset.id,
      reviewerUid: input.reviewerUid,
      decision: 'approved',
      comment: input.comment?.trim() || null,
    });
    const [updated] = await tx
      .update(schema.changesets)
      .set({ status: 'releasing', updatedAt: new Date() })
      .where(eq(schema.changesets.id, changeset.id))
      .returning();
    await writeAudit(tx, {
      actorUid: input.reviewerUid,
      action: 'release.approve',
      env: 'prod',
      outcome: 'ok',
      details: {
        changesetId: changeset.id,
        releaseId: release!.id,
        releaseNumber: number,
        commit: changeset.headCommit,
        destructiveMigration: changeset.destructiveMigration,
      },
    });
    return { releaseId: release!.id, releaseNumber: number, changeset: updated! };
  });
  await enqueue(
    db,
    RELEASE_JOB,
    { releaseId: result.releaseId },
    { dedupeKey: releaseDedupeKey(result.releaseId), maxAttempts: RELEASE_JOB_ATTEMPTS },
  );
  return result;
}

export interface RejectInput {
  changesetId: string;
  reviewerUid: number;
  /** Why the changes are refused; the developer agent receives it as a change request. */
  comment: string;
}

export interface RejectResult {
  reviewId: number;
  changeset: Changeset;
}

/**
 * Rejects a ready changeset with a comment: it goes back to `draft` and the comment reaches
 * the developer agent as a request for changes (`changeset.revise` job).
 */
export async function rejectChangeset(db: Database, input: RejectInput): Promise<RejectResult> {
  const comment = input.comment.trim();
  if (comment === '') {
    throw new ChangesetError('Il rifiuto richiede un commento: spiega cosa va cambiato.');
  }
  const result = await db.transaction(async (tx) => {
    const changeset = await loadChangesetForUpdate(tx, input.changesetId);
    if (changeset.status !== 'ready') {
      throw new ChangesetError(
        `Il changeset è nello stato "${changeset.status}": si può rifiutare solo dopo che i controlli sono passati.`,
      );
    }
    const [review] = await tx
      .insert(schema.reviews)
      .values({
        changesetId: changeset.id,
        reviewerUid: input.reviewerUid,
        decision: 'rejected',
        comment,
      })
      .returning({ id: schema.reviews.id });
    const [updated] = await tx
      .update(schema.changesets)
      // A new round of work starts: the correction attempts are available again.
      .set({ status: 'draft', autofixAttempts: 0, updatedAt: new Date() })
      .where(eq(schema.changesets.id, changeset.id))
      .returning();
    await writeAudit(tx, {
      actorUid: input.reviewerUid,
      action: 'release.reject',
      env: 'staging',
      outcome: 'ok',
      details: { changesetId: changeset.id, reviewId: review!.id, comment },
    });
    return { reviewId: review!.id, changeset: updated! };
  });
  await enqueue(
    db,
    REVISE_JOB,
    { changesetId: input.changesetId, reviewId: result.reviewId },
    { dedupeKey: reviseDedupeKey(input.changesetId), maxAttempts: 1 },
  );
  return result;
}

/** The message the developer agent receives when a reviewer refuses the changeset. */
export function buildChangeRequestPrompt(input: {
  title: string;
  reviewerUsername: string | null;
  comment: string;
}): string {
  return [
    `Il changeset "${input.title}" è stato rifiutato in revisione${
      input.reviewerUsername ? ` da ${input.reviewerUsername}` : ''
    } con questa richiesta di modifiche:`,
    '',
    '```',
    input.comment.trim(),
    '```',
    '',
    'Applica le modifiche richieste senza allargare il perimetro del changeset. Al termine i controlli verranno rieseguiti in automatico e il changeset tornerà in revisione.',
  ].join('\n');
}
