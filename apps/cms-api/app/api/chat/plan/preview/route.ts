import { pendingPlanPreview } from '@/lib/chat.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { json } from '@/lib/http.ts';
import { principalOf, route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/**
 * The page `?path=` (`/site/pages/chi-siamo`) as the plan waiting in `?conversationId=` would
 * leave it (E7.5): the widget swaps it into `<main>` until the person answers. Read-only.
 */
export const GET = route(async (request, context) => {
  const params = new URL(request.url).searchParams;
  const conversationId = params.get('conversationId');
  const path = params.get('path');
  if (!conversationId || !path) throw new BadRequestError('Mancano la conversazione o la pagina.');
  const preview = await pendingPlanPreview(
    { uid: principalOf(context).uid, env: context.env },
    conversationId,
    path,
  );
  return json({ preview });
});
