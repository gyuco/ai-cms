import { listNodeConversations } from '@ai-cms/ai-config';
import { getContent } from '@ai-cms/content/service';
import { AuthzError } from '@ai-cms/authz';
import { NotFoundError } from '@ai-cms/tree';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';
import { principalOf, route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/**
 * History of the chat on a page (E7.4): the user's own conversations started from the node
 * `?path=` (`/site/pages/chi-siamo`), most recent first.
 */
export const GET = route(async (request, context) => {
  const path = new URL(request.url).searchParams.get('path');
  if (!path) return json({ conversations: [] });
  const principal = principalOf(context);
  try {
    const { node } = await getContent(db(), principal, context.env, path);
    const conversations = await listNodeConversations(
      db(),
      { uid: principal.uid, env: context.env },
      node.id,
    );
    return json({ conversations });
  } catch (err) {
    // A page that does not exist yet has no history.
    if (err instanceof NotFoundError || err instanceof AuthzError)
      return json({ conversations: [] });
    throw err;
  }
});
