import { unpublish } from '@ai-cms/content/service';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';
import { principalOf, readBody, requireString, route } from '@/lib/route.ts';
import { revalidateSite } from '@/lib/sites.ts';

export const dynamic = 'force-dynamic';

/** Withdraws a page from the site. Body: `{ path }`. */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const path = requireString(body, 'path', 'Indica la pagina.');
  const result = await unpublish(db(), principalOf(context), context.env, path, {
    onPublished: revalidateSite,
  });
  return json(result);
});
