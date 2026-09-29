import { runChatTurn } from '@/lib/chat.ts';
import { runDevChatTurn } from '@/lib/dev-chat.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { optionalString, principalOf, readBody, requireString, route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

const MAX_MESSAGE_LENGTH = 20_000;

/**
 * Chat tab (E7.4): one turn with the content agent (or, with `agent: "dev-agent"` and a
 * `changesetId`, with the developer agent in staging, E10.11), streamed as server-sent events
 * (`ChatStreamEvent` in `@ai-cms/agents`). The environment is the host's, never the client's.
 */
export const POST = route(async (request, context) => {
  const body = await readBody(request);
  const message = requireString(body, 'message', 'Scrivi un messaggio per l’agente.');
  if (message.length > MAX_MESSAGE_LENGTH)
    throw new BadRequestError('Il messaggio è troppo lungo.');
  if (body.agent === 'dev-agent') {
    return runDevChatTurn(
      { uid: principalOf(context).uid, env: context.env },
      {
        message,
        changesetId: requireString(body, 'changesetId', 'Scegli la modifica su cui lavorare.'),
      },
      request.signal,
    );
  }
  const selected = body.selected;
  if (selected !== undefined && selected !== null && typeof selected !== 'object') {
    throw new BadRequestError('Elemento selezionato non valido.');
  }
  const block = selected as
    { path?: unknown; blockId?: unknown; text?: unknown } | null | undefined;
  return runChatTurn(
    { uid: principalOf(context).uid, env: context.env },
    {
      message,
      conversationId: optionalString(body, 'conversationId'),
      path: optionalString(body, 'path'),
      selected:
        block && typeof block.blockId === 'string'
          ? {
              path: typeof block.path === 'string' ? block.path : null,
              blockId: block.blockId,
              text: typeof block.text === 'string' ? block.text.slice(0, 300) : '',
            }
          : null,
    },
    request.signal,
  );
});
