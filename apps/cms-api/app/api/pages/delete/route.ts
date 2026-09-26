import { deletePage } from '@ai-cms/content/service';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';
import { optionalNumber, principalOf, readBody, requireString, route } from '@/lib/route.ts';
import { revalidatePages } from '@/lib/sites.ts';

export const dynamic = 'force-dynamic';

/** Deletes a page and the pages inside it. Body: `{ path, expectedVersion? }`. */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const path = requireString(body, 'path', 'Indica la pagina.');
  const node = await deletePage(db(), principalOf(context), context.env, path, {
    expectedVersion: optionalNumber(body, 'expectedVersion'),
  });
  return json({ path: node.path, ...(await revalidatePages(context.env)) });
});
