import { publish } from '@ai-cms/content/service';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';
import { renderValidator } from '@/lib/page-rules.ts';
import { optionalNumber, principalOf, readBody, requireString, route } from '@/lib/route.ts';
import { revalidateSite } from '@/lib/sites.ts';

export const dynamic = 'force-dynamic';

/**
 * Publishes a version, by default the latest. Body: `{ path, version? }`.
 * The draft is rendered and checked against the HTML rules first: serious errors keep it out
 * of the site and the reason comes back in the error (E6.7, FR-168).
 */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const path = requireString(body, 'path', 'Indica la pagina.');
  const result = await publish(db(), principalOf(context), context.env, path, {
    version: optionalNumber(body, 'version'),
    onPublished: revalidateSite,
    validateRendered: renderValidator(db(), principalOf(context), context.env),
  });
  return json(result);
});
