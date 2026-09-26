import { getSiteOverview, saveSiteSettings } from '@ai-cms/content/service';
import { db } from '@/lib/db.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { json } from '@/lib/http.ts';
import { optionalNumber, principalOf, readBody, route } from '@/lib/route.ts';
import { revalidateSite } from '@/lib/sites.ts';

export const dynamic = 'force-dynamic';

/** Site tab (E7.8): settings, layouts and menus. */
export const GET = route(async (_request, context) =>
  json(await getSiteOverview(db(), principalOf(context), context.env)),
);

/**
 * Saves and publishes the site settings. Body: `{ settings: { name, lang, titleTemplate, … },
 * expectedVersion? }`.
 */
export const PUT = route(async (request, context) => {
  const body = await readBody(request);
  if (!body.settings || typeof body.settings !== 'object') {
    throw new BadRequestError('Indica le impostazioni del sito.');
  }
  const result = await saveSiteSettings(db(), principalOf(context), context.env, body.settings, {
    expectedVersion: optionalNumber(body, 'expectedVersion'),
    onPublished: revalidateSite,
  });
  return json(result);
});
