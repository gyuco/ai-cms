import type { ChatEvent, ChatMessage, ToolSpec } from '@ai-cms/ai';
import type { Database } from '@ai-cms/db';
import { z } from 'zod';
import { resolveAgentSession } from './agent-sessions.ts';
import { GatewayError, type Gateway } from './gateway.ts';
import { AI_ROLES, TOOL_ROLES, type AiRole } from './roles.ts';

const provider = z.enum(['anthropic', 'openai', 'google', 'openai-compatible']);

const userPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
]);

const assistantPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('reasoning'), provider, data: z.unknown() }),
]);

const message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.array(userPart) }),
  z.object({ role: z.literal('assistant'), content: z.array(assistantPart) }),
]);

const tool = z.object({
  name: z.string().min(1).max(128),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});

/** Body of `POST /_cms/internal/ai/chat`: a normalized ChatRequest plus the AI role. */
export const internalChatBody = z.object({
  role: z.enum(AI_ROLES).optional(),
  request: z.object({
    system: z.string(),
    messages: z.array(message).max(10_000),
    tools: z.array(tool).max(256).default([]),
    maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  }),
});

export type InternalChatBody = z.input<typeof internalChatBody>;

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Internal AI endpoint for the agent-runner, which never holds API keys (TECHNICAL §7.2).
 * Authenticated with an agent session token; streams `ChatEvent`s as NDJSON. The model is
 * always the one assigned to the role: the runner cannot pick another one.
 */
export async function handleInternalChat(
  request: Request,
  deps: { db: Database; gateway: Gateway },
): Promise<Response> {
  const token = bearer(request);
  const session = token ? await resolveAgentSession(deps.db, token) : null;
  if (!session)
    return jsonError(401, 'unauthenticated', 'Token di sessione agente mancante o scaduto.');

  const parsed = internalChatBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(
      400,
      'bad_request',
      `Richiesta non valida: ${parsed.error.issues[0]?.message ?? ''}`,
    );
  }
  const role: AiRole = parsed.data.role ?? session.agent;
  // An agent session may use its own agent role, or the non-agent roles (review, translate…).
  if (TOOL_ROLES.includes(role) && role !== session.agent) {
    return jsonError(
      403,
      'forbidden_role',
      `La sessione dell'agente "${session.agent}" non può usare il ruolo "${role}".`,
    );
  }

  let opened;
  try {
    opened = await deps.gateway.open({
      uid: session.principal.uid,
      role,
      conversationId: session.conversationId,
    });
  } catch (err) {
    if (err instanceof GatewayError) return jsonError(err.status, err.code, err.message);
    throw err;
  }

  const req = parsed.data.request;
  const events = opened.engine.stream({
    model: opened.model,
    system: req.system,
    messages: req.messages as ChatMessage[],
    tools: req.tools as ToolSpec[],
    ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
    // The runner hanging up aborts the provider call.
    signal: request.signal,
  });
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(next.value satisfies ChatEvent)}\n`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const events: ChatEvent[] = [
          { type: 'error', message },
          { type: 'done', stopReason: 'error' },
        ];
        for (const event of events)
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-ai-connection': opened.connection.id,
      'x-ai-model': opened.model,
    },
  });
}
