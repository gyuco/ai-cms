import { publish } from '@ai-cms/content/service';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';
import { optionalNumber, principalOf, readBody, requireString, route } from '@/lib/route.ts';
import { revalidateSite } from '@/lib/sites.ts';

export const dynamic = 'force-dynamic';

/** Publishes a version, by default the latest. Body: `{ path, version? }`. */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const path = requireString(body, 'path', 'Indica la pagina.');
  const result = await publish(db(), principalOf(context), context.env, path, {
    version: optionalNumber(body, 'version'),
    onPublished: revalidateSite,
  });
  return json(result);
});
