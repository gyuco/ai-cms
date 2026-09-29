import { approveChangeset, ChangesetError, isChangesetId } from '@ai-cms/pipeline';
import { db } from '@/lib/db.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { error, json } from '@/lib/http.ts';
import { readBody, route, type Body } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/**
 * "Approva e pubblica" (FR-51): approves a ready changeset and queues its release. Phase 1:
 * any authenticated user may approve (the capabilities arrive in phase 2). A changeset with a
 * destructive migration needs `confirmDestructive: true`.
 */
export const POST = route<{ id: string }>(async (request, context, { id }) => {
  if (!isChangesetId(id)) throw new BadRequestError('Id di changeset non valido.');
  const body: Body = await readBody(request).catch(() => ({}));
  try {
    const result = await approveChangeset(db(), {
      changesetId: id,
      reviewerUid: context.session.user.uid,
      confirmDestructive: body.confirmDestructive === true,
      comment: typeof body.comment === 'string' ? body.comment : null,
    });
    return json(
      {
        releaseId: result.releaseId,
        releaseNumber: result.releaseNumber,
        status: result.changeset.status,
      },
      { status: 202 },
    );
  } catch (err) {
    if (err instanceof ChangesetError) {
      return error(err.message.includes('non trovato') ? 404 : 409, 'changeset_state', err.message);
    }
    throw err;
  }
});
