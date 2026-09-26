import { renamePage } from '@ai-cms/content/service';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';
import { optionalNumber, principalOf, readBody, requireString, route } from '@/lib/route.ts';
import { revalidatePages } from '@/lib/sites.ts';

export const dynamic = 'force-dynamic';

/** Renames a page (its URL changes). Body: `{ path, name, expectedVersion? }`. */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const path = requireString(body, 'path', 'Indica la pagina.');
  const name = requireString(body, 'name', 'Indica il nuovo nome.');
  const node = await renamePage(db(), principalOf(context), context.env, path, name, {
    expectedVersion: optionalNumber(body, 'expectedVersion'),
  });
  return json({ path: node.path, ...(await revalidatePages(context.env)) });
});
