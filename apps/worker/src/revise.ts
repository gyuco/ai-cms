import { writeAudit } from '@ai-cms/audit';
import { schema, type Database } from '@ai-cms/db';
import {
  buildChangeRequestPrompt,
  enqueue,
  isChangesetId,
  type JobHandler,
} from '@ai-cms/pipeline';
import { eq } from 'drizzle-orm';
import { runDevAgent, type AutofixOptions } from './autofix.ts';

/**
 * The `changeset.revise` job: a reviewer rejected a changeset with a comment, and the
 * developer agent receives it as a request for changes. Afterwards the checks run again, so
 * the changeset comes back to review by itself. Payload: `{ changesetId, reviewId }`.
 */
export function reviseHandler(db: Database, options: AutofixOptions = {}): JobHandler {
  return async (payload) => {
    const { changesetId, reviewId } = (payload ?? {}) as {
      changesetId?: unknown;
      reviewId?: unknown;
    };
    if (!isChangesetId(changesetId)) throw new Error('payload.changesetId mancante');
    if (typeof reviewId !== 'number') throw new Error('payload.reviewId mancante');

    const [changeset] = await db
      .select()
      .from(schema.changesets)
      .where(eq(schema.changesets.id, changesetId));
    if (!changeset) throw new Error(`Changeset ${changesetId} non trovato`);
    const [review] = await db
      .select({
        comment: schema.reviews.comment,
        decision: schema.reviews.decision,
        username: schema.users.username,
      })
      .from(schema.reviews)
      .innerJoin(schema.users, eq(schema.users.uid, schema.reviews.reviewerUid))
      .where(eq(schema.reviews.id, reviewId));
    if (!review || review.decision !== 'rejected' || !review.comment) {
      throw new Error(`Revisione ${String(reviewId)} senza richiesta di modifiche`);
    }
    if (changeset.status !== 'draft') return { skipped: `stato "${changeset.status}"` };

    const outcome = await runDevAgent(db, options, {
      changeset,
      prompt: buildChangeRequestPrompt({
        title: changeset.title,
        reviewerUsername: review.username,
        comment: review.comment,
      }),
    });
    await writeAudit(db, {
      actorUid: changeset.authorUid,
      action: 'changeset.revise',
      env: 'staging',
      outcome: outcome.ok ? 'ok' : 'error',
      details: { changesetId, reviewId, detail: outcome.detail ?? null },
    });
    await enqueue(
      db,
      'changeset.check',
      { changesetId },
      { dedupeKey: `changeset.check:${changesetId}` },
    );
    return { ok: outcome.ok, detail: outcome.detail ?? null };
  };
}
