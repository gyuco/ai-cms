import { restoreVersion } from '@ai-cms/content/service';
import { db } from '@/lib/db.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { json } from '@/lib/http.ts';
import { optionalNumber, principalOf, readBody, requireString, route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/**
 * Creates a new draft equal to an earlier version (FR-62).
 * Body: `{ path, version, expectedVersion? }`.
 */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const path = requireString(body, 'path', 'Indica la pagina.');
  const version = optionalNumber(body, 'version');
  if (version === undefined) throw new BadRequestError('Indica la versione da ripristinare.');
  const restored = await restoreVersion(db(), principalOf(context), context.env, path, version, {
    expectedVersion: optionalNumber(body, 'expectedVersion'),
  });
  return json({ version: restored.version });
});
