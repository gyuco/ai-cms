import { ChangesetError, isChangesetId, requestRollback } from '@ai-cms/pipeline';
import { db } from '@/lib/db.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { error, json } from '@/lib/http.ts';
import { route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/**
 * "Rollback" (FR-53): puts the previous release back in front of the site. Only the release
 * in production can be undone. The database is not restored. Answers 202 while the worker
 * switches the artifact; the history shows the outcome (`rolled_back`). Phase 1: any
 * authenticated user may roll back (the capabilities arrive in phase 2).
 */
export const POST = route<{ id: string }>(async (_request, context, { id }) => {
  if (!isChangesetId(id)) throw new BadRequestError('Id di release non valido.');
  try {
    const result = await requestRollback(db(), {
      releaseId: id,
      actorUid: context.session.user.uid,
    });
    return json(result, { status: 202 });
  } catch (err) {
    if (err instanceof ChangesetError) {
      return error(err.message.includes('non trovata') ? 404 : 409, 'release_state', err.message);
    }
    throw err;
  }
});
