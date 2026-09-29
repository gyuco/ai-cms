import { ChangesetError, isChangesetId, rejectChangeset } from '@ai-cms/pipeline';
import { db } from '@/lib/db.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { error, json } from '@/lib/http.ts';
import { readBody, requireString, route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/**
 * Rejects a ready changeset with a mandatory comment. The changeset goes back to `draft` and
 * the developer agent receives the comment as a request for changes.
 */
export const POST = route<{ id: string }>(async (request, context, { id }) => {
  if (!isChangesetId(id)) throw new BadRequestError('Id di changeset non valido.');
  const body = await readBody(request);
  const comment = requireString(body, 'comment', 'Il rifiuto richiede un commento.');
  try {
    const result = await rejectChangeset(db(), {
      changesetId: id,
      reviewerUid: context.session.user.uid,
      comment,
    });
    return json({ reviewId: result.reviewId, status: result.changeset.status }, { status: 202 });
  } catch (err) {
    if (err instanceof ChangesetError) {
      return error(err.message.includes('non trovato') ? 404 : 409, 'changeset_state', err.message);
    }
    throw err;
  }
});
