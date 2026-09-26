import { movePage } from '@ai-cms/content/service';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';
import { optionalNumber, principalOf, readBody, requireString, route } from '@/lib/route.ts';
import { revalidatePages } from '@/lib/sites.ts';

export const dynamic = 'force-dynamic';

/** Moves a page under another one. Body: `{ path, parent, expectedVersion? }`. */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const path = requireString(body, 'path', 'Indica la pagina.');
  const parent = requireString(body, 'parent', 'Indica dove spostare la pagina.');
  const node = await movePage(db(), principalOf(context), context.env, path, parent, {
    expectedVersion: optionalNumber(body, 'expectedVersion'),
  });
  return json({ path: node.path, ...(await revalidatePages(context.env)) });
});
