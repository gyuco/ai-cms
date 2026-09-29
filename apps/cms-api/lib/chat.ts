import {
  buildContentAgentPrompt,
  confirmContentPlan,
  encodeSse,
  isBlockedResult,
  PlanStore,
  previewContentPlan,
  requiresConfirmation,
  toolLabel,
  toPlanView,
  type ChatStreamEvent,
  type PageContext,
  type PlanSession,
  type PlanView,
} from '@ai-cms/agents';
import { defineTool, runAgent, type ChatMessage, type Tool } from '@ai-cms/ai';
import {
  appendMessages,
  createConversation,
  GatewayError,
  getOwnConversation,
  issueAgentSession,
  setConversationNode,
  resolveAgentSession,
  revokeAgentSession,
  type Conversation,
  type ResolvedAgentSession,
} from '@ai-cms/ai-config';
import { outline, parsePageBody } from '@ai-cms/content';
import { getContent, PlanError, planSchema } from '@ai-cms/content/service';
import { AuthzError } from '@ai-cms/authz';
import { NotFoundError } from '@ai-cms/tree';
import { renderMainMarkup } from '@ai-cms/site-kit/document';
import { z } from 'zod';
import { assetStorage } from './assets.ts';
import { db } from './db.ts';
import { gateway } from './ai.ts';
import { BadRequestError } from './errors.ts';
import type { Env } from './http.ts';
import { contentContext, registry } from './mcp.ts';
import { renderValidator } from './page-rules.ts';
import { revalidateSite } from './sites.ts';

export const AGENT = 'content-agent';

/** Plans waiting for "Conferma" / "Annulla" (E7.4); one cms-api instance in the MVP 1. */
export const plans = new PlanStore();

/** Tools of the developer agent are refused to the content agent: do not even offer them. */
const DEV_TOOLS = new Set(['run_checks', 'get_check_results', 'query_staging_db', 'open_preview']);

const MAX_HISTORY_MESSAGES = 200;
const TITLE_LENGTH = 80;

export interface ChatOwner {
  uid: number;
  env: Env;
}

export interface SelectedBlockInput {
  path: string | null;
  blockId: string;
  text: string;
}

export interface ChatTurnInput {
  message: string;
  conversationId: string | null;
  /** Tree path of the page the widget is on (`/site/pages/chi-siamo`), if any. */
  path: string | null;
  selected: SelectedBlockInput | null;
}

const PLAN_INSTRUCTIONS = `Per le modifiche che toccano più nodi, o che sono distruttive (eliminare, sovrascrivere \
tutto il contenuto di una pagina), non eseguirle una alla volta: proponile con lo strumento \
propose_plan. Il piano viene validato senza scrivere nulla e la persona lo vede con i pulsanti \
"Conferma" e "Annulla". Dopo averlo proposto fermati: spiega in una frase cosa farà il piano e \
aspetta la sua risposta, non riproporlo. Se il piano viene rifiutato per un errore, correggilo e \
proponilo di nuovo.`;

/**
 * Runs `work` with the profile of the content agent: the user masked by the profile, for one
 * conversation. The token lives only as long as the call.
 */
async function withAgentSession<T>(
  owner: ChatOwner,
  conversationId: string,
  work: (session: ResolvedAgentSession) => Promise<T>,
): Promise<T> {
  const { token } = await issueAgentSession(db(), {
    uid: owner.uid,
    agent: AGENT,
    env: owner.env,
    conversationId,
    ttlMs: 10 * 60 * 1000,
  });
  try {
    const session = await resolveAgentSession(db(), token);
    if (!session) throw new Error('Sessione agente non disponibile.');
    return await work(session);
  } finally {
    await revokeAgentSession(db(), token).catch(() => undefined);
  }
}

/** The page the widget is on, as the prompt needs it. Best effort: the chat works without it. */
async function pageContextOf(
  owner: ChatOwner,
  principal: ResolvedAgentSession['principal'],
  input: ChatTurnInput,
): Promise<{ context: PageContext; nodeId: string | null }> {
  const context: PageContext = {
    env: owner.env,
    path: input.path,
    title: null,
    outline: [],
    selected: input.selected,
  };
  if (!input.path) return { context, nodeId: null };
  try {
    const snapshot = await getContent(db(), principal, owner.env, input.path);
    const body = snapshot.body as { meta?: { title?: string }; blocks?: unknown[] } | null;
    context.title = body?.meta?.title ?? null;
    context.outline = outline((body?.blocks ?? []) as Parameters<typeof outline>[0]);
    return { context, nodeId: snapshot.node.id };
  } catch (err) {
    // A page that does not exist yet, or that the agent cannot read: talk about it anyway.
    if (err instanceof NotFoundError || err instanceof AuthzError) return { context, nodeId: null };
    throw err;
  }
}

/** Model history of a stored conversation, plus the notes the user's answers left in it. */
export function historyOf(conversation: Conversation): {
  messages: ChatMessage[];
  notes: string[];
} {
  const messages: ChatMessage[] = [];
  let notes: string[] = [];
  for (const row of conversation.messages.slice(-MAX_HISTORY_MESSAGES)) {
    const content = row.content as ChatMessage['content'];
    if (row.role === 'system') {
      const text = (row.content as { text?: string }[] | null)?.[0]?.text;
      if (text) notes.push(text);
    } else if (row.role === 'assistant') {
      messages.push({ role: 'assistant', content: content as never });
      notes = [];
    } else {
      messages.push({ role: 'user', content: content as never });
      notes = [];
    }
  }
  return { messages, notes };
}

function planTool(args: {
  owner: ChatOwner;
  principal: ResolvedAgentSession['principal'];
  conversationId: string;
  session: PlanSession;
  emit: (event: ChatStreamEvent) => void;
}): Tool {
  const { owner, principal, conversationId, session, emit } = args;
  return defineTool({
    name: 'propose_plan',
    description:
      'Propone alla persona un piano di modifiche su più nodi: viene validato senza scrivere ' +
      'nulla e mostrato con Conferma / Annulla. Usalo per modifiche multiple o distruttive. ' +
      'Ogni operazione ha un campo `op`; `body` ha la forma del tipo di nodo: pagina ' +
      '{"meta":{"title":"..."},"blocks":[{"id":"titolo","type":"heading","level":1,"text":"..."},' +
      '{"id":"testo","type":"paragraph","content":[{"text":"..."}]}]}, layout {"blocks":[...]}, ' +
      'menu {"items":[{"label":"...","href":"/..."}]}. `blocks` è sempre un array; ogni titolo ' +
      'ha `level` (1-6); `content` di un paragrafo è un array di frammenti {"text":"..."}.',
    input: z.object({ operations: planSchema }),
    async run({ operations }) {
      const before = session.operations();
      for (const operation of operations) session.propose(operation);
      try {
        const preview = await previewContentPlan(db(), principal, owner.env, session, {
          conversationId,
          viaAgent: AGENT,
          validateRendered: renderValidator(db(), principal, owner.env),
        });
        const all = session.operations();
        const view = toPlanView(all, preview);
        emit({ type: 'plan', plan: view });
        return {
          status: 'in attesa della conferma della persona',
          steps: view.steps,
          needsExplicitConfirmation: view.destructive,
          note: 'Non è stato scritto nulla. Fermati e aspetta la risposta della persona.',
        };
      } catch (err) {
        // Nothing of this call stays in the plan: the agent fixes it and proposes it again.
        session.clear();
        for (const operation of before) session.propose(operation);
        if (err instanceof PlanError) throw new Error(err.message, { cause: err });
        throw err;
      }
    },
  });
}

function noteOf(text: string) {
  return [{ type: 'text', text }];
}

/**
 * One turn of the chat (E7.4): the user's message goes to the content agent, and everything it
 * does streams back as server-sent events. Returns the stream; the work starts when it is read.
 */
export function runChatTurn(owner: ChatOwner, input: ChatTurnInput, signal: AbortSignal): Response {
  return sseResponse((emit) => chatTurn(owner, input, signal, emit));
}

/**
 * The stream of a chat turn as an SSE response: `work` emits the events, an error it throws
 * becomes an `error` event and the stream always ends with `done`.
 */
export function sseResponse(
  work: (emit: (event: ChatStreamEvent) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeSse(event)));
        } catch {
          // The reader went away: the work goes on to the end and is saved.
        }
      };
      try {
        await work(emit);
      } catch (err) {
        emit({ type: 'error', message: chatErrorMessage(err) });
        emit({ type: 'done', stopReason: 'error' });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}

/** What the user reads when the turn cannot even start. */
export function chatErrorMessage(err: unknown): string {
  if (err instanceof GatewayError) {
    return err.code === 'cli_engine'
      ? "L'agente contenuti è collegato a un abbonamento Claude Code, che non è ancora disponibile nella chat: scegli una connessione con chiave API nella scheda AI."
      : err.message;
  }
  if (err instanceof BadRequestError || err instanceof AuthzError) return err.message;
  return 'Qualcosa è andato storto e la richiesta non è stata completata. Riprova tra poco.';
}

async function chatTurn(
  owner: ChatOwner,
  input: ChatTurnInput,
  signal: AbortSignal,
  emit: (event: ChatStreamEvent) => void,
): Promise<void> {
  let conversation: Conversation | null = null;
  if (input.conversationId) {
    conversation = await getOwnConversation(db(), input.conversationId, owner);
    if (!conversation) throw new BadRequestError('Conversazione non trovata.');
  }
  // Ids are needed by the agent session, so a new conversation is opened first.
  const title = input.message.slice(0, TITLE_LENGTH);
  const conversationId =
    conversation?.id ??
    (await createConversation(db(), {
      uid: owner.uid,
      env: owner.env,
      agent: AGENT,
      nodeId: null,
      title,
    }));

  await withAgentSession(owner, conversationId, async (session) => {
    const { context, nodeId } = await pageContextOf(owner, session.principal, input);
    if (!conversation && nodeId) await setConversationNode(db(), conversationId, nodeId);
    emit({ type: 'conversation', id: conversationId, title: conversation?.title ?? title });

    const opened = await gateway().open({
      uid: owner.uid,
      role: AGENT,
      conversationId,
    });

    const history = conversation ? historyOf(conversation) : { messages: [], notes: [] };
    const text = [...history.notes.map((note) => `[${note}]`), input.message].join('\n\n');
    const userMessage: ChatMessage = { role: 'user', content: [{ type: 'text', text }] };
    await appendMessages(db(), conversationId, [{ role: 'user', content: userMessage.content }]);

    const planSession = plans.session(conversationId, owner);
    const tools: Tool[] = [
      ...registry
        .bind(contentContext(session.principal, owner.env, session, await assetStorage()))
        .filter((tool) => !DEV_TOOLS.has(tool.name)),
      planTool({
        owner,
        principal: session.principal,
        conversationId,
        session: planSession,
        emit,
      }),
    ];

    const result = await runAgent({
      engine: opened.engine,
      model: opened.model,
      system: `${buildContentAgentPrompt(context)}\n\n${PLAN_INSTRUCTIONS}`,
      messages: [...history.messages, userMessage],
      tools,
      signal,
      onEvent(event) {
        switch (event.type) {
          case 'step':
            emit({ type: 'status', state: 'thinking' });
            break;
          case 'text_delta':
            emit({ type: 'text', text: event.text });
            break;
          case 'tool_call':
            emit({ type: 'status', state: 'working' });
            emit({
              type: 'tool_start',
              id: event.id,
              name: event.name,
              label: toolLabel(event.name),
            });
            break;
          case 'tool_result':
            emit({
              type: 'tool_end',
              id: event.toolCallId,
              name: event.name,
              ok: !event.isError,
              blocked: event.isError && isBlockedResult(event.content),
              ...(event.isError ? { detail: event.content } : {}),
            });
            break;
          case 'error':
            emit({ type: 'error', message: event.message });
            break;
        }
      },
    });

    await appendMessages(
      db(),
      conversationId,
      result.messages.map((message) => ({
        // Tool results travel as user messages; they are stored apart so the history can skip them.
        role: message.role === 'assistant' ? 'assistant' : isToolResults(message) ? 'tool' : 'user',
        content: message.content,
      })),
    );
    emit({ type: 'done', stopReason: result.stopReason });
  });
}

function isToolResults(message: ChatMessage): boolean {
  return message.role === 'user' && message.content.every((part) => part.type === 'tool_result');
}

export interface PlanAnswer {
  conversationId: string;
  action: 'confirm' | 'cancel';
  /** Explicit consent to a destructive plan (FR-06). */
  confirmDestructive: boolean;
}

export type PlanAnswerResult =
  | { status: 'applied'; touched: string[]; published: string[]; hookError?: string }
  | { status: 'cancelled' };

async function requirePendingPlan(
  owner: ChatOwner,
  conversationId: string,
): Promise<{ session: PlanSession; conversation: Conversation }> {
  const conversation = await getOwnConversation(db(), conversationId, owner);
  if (!conversation) throw new NotFoundError('Conversazione non trovata.');
  const session = plans.find(conversationId, owner);
  if (!session) {
    throw new NotFoundError(
      'Non c’è nessun piano in attesa: è già stato confermato, annullato o è scaduto.',
    );
  }
  return { session, conversation };
}

/** "Conferma" / "Annulla" on the plan the agent proposed. */
export async function answerPlan(owner: ChatOwner, answer: PlanAnswer): Promise<PlanAnswerResult> {
  const { session } = await requirePendingPlan(owner, answer.conversationId);

  if (answer.action === 'cancel') {
    plans.discard(answer.conversationId);
    await appendMessages(db(), answer.conversationId, [
      {
        role: 'system',
        content: noteOf('La persona ha annullato il piano proposto: non è stato modificato nulla'),
      },
    ]);
    return { status: 'cancelled' };
  }

  return withAgentSession(owner, answer.conversationId, async ({ principal }) => {
    const options = {
      conversationId: answer.conversationId,
      viaAgent: AGENT,
      onPublished: revalidateSite,
      validateRendered: renderValidator(db(), principal, owner.env),
    };
    // The plan is checked again: the tree may have changed since the agent proposed it.
    const preview = await previewContentPlan(db(), principal, owner.env, session, options);
    if (requiresConfirmation(session.operations(), preview) && !answer.confirmDestructive) {
      throw new BadRequestError('Il piano è distruttivo: serve una conferma esplicita.');
    }
    const result = await confirmContentPlan(db(), principal, owner.env, session, options);
    plans.discard(answer.conversationId);
    await appendMessages(db(), answer.conversationId, [
      {
        role: 'system',
        content: noteOf(
          `La persona ha confermato il piano ed è stato eseguito (${result.touched.join(', ')})`,
        ),
      },
    ]);
    return {
      status: 'applied',
      touched: result.touched,
      published: result.published,
      ...(result.hookError ? { hookError: result.hookError } : {}),
    };
  });
}

/** The plan still waiting in a conversation, for the widget that reopens it. */
export async function pendingPlan(
  owner: ChatOwner,
  conversationId: string,
): Promise<PlanView | null> {
  const session = plans.find(conversationId, owner);
  if (!session) return null;
  return withAgentSession(owner, conversationId, async ({ principal }) => {
    try {
      const preview = await previewContentPlan(db(), principal, owner.env, session, {
        conversationId,
        viaAgent: AGENT,
        validateRendered: renderValidator(db(), principal, owner.env),
      });
      return toPlanView(session.operations(), preview);
    } catch (err) {
      // The tree moved on and the plan no longer applies: it is not offered any more.
      if (err instanceof PlanError) {
        plans.discard(conversationId);
        return null;
      }
      throw err;
    }
  });
}

/** A page as the plan would leave it, for the in-place preview of the widget (E7.5). */
export interface PlanPagePreview {
  path: string;
  created: boolean;
  /** The markup inside `<main>`, as the site renders it. */
  html: string;
  /** Blocks of `html` the plan adds or edits, by `data-cms-block`. */
  added: string[];
  modified: string[];
  /** Blocks the plan takes away: they are not in `html`, so the widget only lists them. */
  removed: { id: string; type: string }[];
}

/**
 * The page `path` as the plan waiting in the conversation would leave it, rendered like the
 * site does. The plan is dry-run again, so nothing is written and the preview is never older
 * than the tree. `null` when the plan does not touch that page.
 */
export async function pendingPlanPreview(
  owner: ChatOwner,
  conversationId: string,
  path: string,
): Promise<PlanPagePreview | null> {
  const { session } = await requirePendingPlan(owner, conversationId);
  return withAgentSession(owner, conversationId, async ({ principal }) => {
    const result = await previewContentPlan(db(), principal, owner.env, session, {
      conversationId,
      viaAgent: AGENT,
      validateRendered: renderValidator(db(), principal, owner.env),
    });
    const page = (result.preview ?? []).find((entry) => entry.path === path);
    if (!page || page.kind !== 'page') return null;
    const body = parsePageBody(page.body);
    // A body that is not a valid page is shown only in the plan card, never as markup.
    if (!body.ok) return null;
    return {
      path: page.path,
      created: page.created,
      html: renderMainMarkup(body.value),
      added: page.diff.blocks.added.map((block) => block.id),
      modified: page.diff.blocks.modified.map((block) => block.id),
      removed: page.diff.blocks.removed.map((block) => ({ id: block.id, type: block.type })),
    };
  });
}

export interface ChatLine {
  id: number;
  role: 'user' | 'assistant' | 'note';
  text: string;
  /** Tools the assistant used in this message, by label. */
  tools: string[];
  at: string;
}

/** The conversation as the widget lists it: text only, tool traffic folded into the message. */
export function linesOf(conversation: Conversation): ChatLine[] {
  const lines: ChatLine[] = [];
  for (const row of conversation.messages) {
    if (row.role === 'tool') continue;
    const parts = Array.isArray(row.content) ? (row.content as Record<string, unknown>[]) : [];
    const text = parts
      .filter((part) => part.type === 'text')
      .map((part) => String(part.text ?? ''))
      .join('');
    const tools = parts
      .filter((part) => part.type === 'tool_call')
      .map((part) => toolLabel(String(part.name)));
    if (!text && tools.length === 0) continue;
    lines.push({
      id: row.id,
      role: row.role === 'system' ? 'note' : row.role === 'assistant' ? 'assistant' : 'user',
      text,
      tools,
      at: row.createdAt.toISOString(),
    });
  }
  return lines;
}
