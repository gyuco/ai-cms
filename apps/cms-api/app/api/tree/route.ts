import { listTreeEntries } from '@ai-cms/content/service';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';
import { principalOf, route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/** Children of a folder, for the page tree of the Site tab. `?path=` defaults to the pages. */
export const GET = route(async (request, context) => {
  const path = new URL(request.url).searchParams.get('path') || '/site/pages';
  return json({ entries: await listTreeEntries(db(), principalOf(context), context.env, path) });
});
