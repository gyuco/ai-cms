import { listOpenChangesets } from '@ai-cms/pipeline';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';
import { route } from '@/lib/route.ts';

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
