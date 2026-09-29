import { listOpenChangesets } from '@ai-cms/pipeline';
import { startDevChangeset } from '@/lib/dev-chat.ts';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';
import { optionalString, principalOf, readBody, requireString, route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/**
 * Development tab (E7.11): the changesets still open, each with the address of its preview
 * (`cs-<id>` + `PREVIEW_DOMAIN`, `.localhost` by default). Phase 1: every user is an
 * administrator.
 */
export const GET = route(async () => {
  const suffix = process.env.PREVIEW_DOMAIN ?? '.localhost';
  const changesets = await listOpenChangesets(db());
  return json({
    changesets: changesets.map((changeset) => ({
      ...changeset,
      previewUrl: `http://cs-${changeset.id}${suffix}`,
    })),
  });
});

/**
 * "Nuova modifica" (E10.11): opens a chat with the developer agent and asks the worker for the
 * changeset it will work on. The changeset shows up in the list above, tied to the returned
 * `conversationId`, once the worker has cloned the repository. Staging only.
 */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const started = await startDevChangeset(principalOf(context), context.env, {
    title: requireString(body, 'title', 'Dai un titolo alla modifica.'),
    description: optionalString(body, 'description'),
  });
  return json(started, { status: 202 });
});
