import { pageNodePath } from '@ai-cms/content';
import { checkRenderedPage } from '@ai-cms/html-rules';
import { BadRequestError } from '@/lib/errors.ts';
import { json } from '@/lib/http.ts';
import { readBody, requireString, route } from '@/lib/route.ts';
import { siteInternalUrl } from '@/lib/sites.ts';

export const dynamic = 'force-dynamic';

/**
 * HTML rules on the page as the site renders it in this environment (TECHNICAL §11).
 * Body: `{ url }`, the site URL path (`/chi-siamo`). An unreachable site gives a warning.
 */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const url = requireString(body, 'url', 'Indica la pagina da verificare.');
  // Only page URLs: the path is appended to an internal address.
  if (!url.startsWith('/') || pageNodePath(url) === null) {
    throw new BadRequestError('Indirizzo della pagina non valido.');
  }
  return json(await checkRenderedPage(`${siteInternalUrl(context.env)}${url}`));
});
