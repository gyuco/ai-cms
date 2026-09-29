import { listReleases } from '@ai-cms/pipeline';
import { db } from '@/lib/db.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { json } from '@/lib/http.ts';
import { route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

function intParam(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new BadRequestError(`Il parametro "${name}" non è valido.`);
  return n;
}

/**
 * History of the releases (FR-54), newest first: author, approver, date, changesets and
 * outcome. `?limit=` (default 50, at most 200) and `?before=<number>` page through it;
 * `nextBefore` in the answer is the value for the next page. Phase 1: every user is an
 * administrator.
 */
export const GET = route(async (request) => {
  const params = new URL(request.url).searchParams;
  return json(
    await listReleases(db(), {
      limit: intParam(params.get('limit'), 'limit'),
      before: intParam(params.get('before'), 'before'),
    }),
  );
});
