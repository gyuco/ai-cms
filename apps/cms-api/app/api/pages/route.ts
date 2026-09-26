import { createPage, getPageDetails, savePageMeta } from '@ai-cms/content/service';
import { db } from '@/lib/db.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { json } from '@/lib/http.ts';
import {
  optionalNumber,
  principalOf,
  readBody,
  requireQuery,
  requireString,
  route,
} from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/** Page tab (E7.7): `?path=/site/pages/...` → state, metadata and versions. */
export const GET = route(async (request, context) => {
  const path = requireQuery(request, 'path', 'Indica la pagina.');
  return json(await getPageDetails(db(), principalOf(context), context.env, path));
});

/** Creates a page. Body: `{ parent, name, title? }`. */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const parent = requireString(body, 'parent', 'Indica dove creare la pagina.');
  const name = requireString(body, 'name', 'Indica il nome della pagina.');
  const title = typeof body.title === 'string' ? body.title : null;
  const created = await createPage(db(), principalOf(context), context.env, parent, {
    name,
    title,
  });
  return json(
    { path: created.node.path, url: created.url, version: created.version.version },
    { status: 201 },
  );
});

/** Saves new metadata as a draft. Body: `{ path, meta, expectedVersion? }`. */
export const PATCH = route(async (request, context) => {
  const body = await readBody(request);
  const path = requireString(body, 'path', 'Indica la pagina.');
  if (!body.meta || typeof body.meta !== 'object') {
    throw new BadRequestError('Indica i metadati da salvare.');
  }
  const version = await savePageMeta(db(), principalOf(context), context.env, path, body.meta, {
    expectedVersion: optionalNumber(body, 'expectedVersion'),
  });
  return json({ version: version.version });
});
