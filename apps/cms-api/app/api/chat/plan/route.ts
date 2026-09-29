import { answerPlan } from '@/lib/chat.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { json } from '@/lib/http.ts';
import { principalOf, readBody, requireString, route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/**
 * "Conferma" / "Annulla" on the plan the agent proposed (E7.4, E9.3). A destructive plan runs
 * only with `confirmDestructive: true` (FR-06); the plan executes in one transaction (FR-63).
 */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const action = body.action;
  if (action !== 'confirm' && action !== 'cancel') {
    throw new BadRequestError('Azione non valida: usa "confirm" o "cancel".');
  }
  const result = await answerPlan(
    { uid: principalOf(context).uid, env: context.env },
    {
      conversationId: requireString(body, 'conversationId', 'Manca la conversazione.'),
      action,
      confirmDestructive: body.confirmDestructive === true,
    },
  );
  return json(result);
});
