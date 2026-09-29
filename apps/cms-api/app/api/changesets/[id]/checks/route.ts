import { ChangesetError, getChangesetChecksState, isChangesetId } from '@ai-cms/pipeline';
import { db } from '@/lib/db.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { error, json } from '@/lib/http.ts';
import { route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/**
 * Development tab (E7.11): the checks of a changeset as they arrive, and the state of the
 * automatic correction rounds (FR-42). The tab polls this while a changeset is checking.
 * Phase 1: every user is an administrator.
 */
export const GET = route<{ id: string }>(async (_request, _context, { id }) => {
  if (!isChangesetId(id)) throw new BadRequestError('Id di changeset non valido.');
  try {
    return json(await getChangesetChecksState(db(), id));
  } catch (err) {
    if (err instanceof ChangesetError) return error(404, 'not_found', err.message);
    throw err;
  }
});
