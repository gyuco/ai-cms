import { approveDevDependencies } from '@/lib/dev-chat.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { json } from '@/lib/http.ts';
import { principalOf, readBody, requireString, route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/**
 * "Approva" on the packages the developer agent needs (E10.11, FR-37). Only the person's own
 * session reaches this route; it is what allows `pnpm add` in the chat from the next turn on.
 */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const packages = body.packages;
  if (!Array.isArray(packages) || packages.some((name) => typeof name !== 'string')) {
    throw new BadRequestError('Indica i pacchetti da approvare.');
  }
  const approved = await approveDevDependencies(
    { uid: principalOf(context).uid, env: context.env },
    {
      conversationId: requireString(body, 'conversationId', 'Manca la conversazione.'),
      packages: packages as string[],
    },
  );
  return json({ approved });
});
