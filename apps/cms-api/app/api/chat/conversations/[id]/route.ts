import { getOwnConversation } from '@ai-cms/ai-config';
import { linesOf, pendingPlan } from '@/lib/chat.ts';
import { db } from '@/lib/db.ts';
import { NotFoundError } from '@ai-cms/tree';
import { json } from '@/lib/http.ts';
import { principalOf, route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/** One conversation of the chat tab, with the plan still waiting for an answer, if any. */
export const GET = route<{ id: string }>(async (_request, context, { id }) => {
  const owner = { uid: principalOf(context).uid, env: context.env };
  const conversation = await getOwnConversation(db(), id, owner);
  if (!conversation) throw new NotFoundError('Conversazione non trovata.');
  return json({
    id: conversation.id,
    title: conversation.title,
    lines: linesOf(conversation),
    plan: await pendingPlan(owner, id),
  });
});
