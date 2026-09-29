/**
 * The chat with the developer agent (E10.11): in staging a person opens a changeset and talks
 * to the agent that works on its clone. The agent itself runs in the agent-runner; this module
 * starts the run, forwards its stream to the widget in the same events as the content chat,
 * and keeps what the person has to decide themselves: which packages `pnpm add` may install.
 */
import { checkCommand, toolLabel, type ChatStreamEvent } from '@ai-cms/agents';
import type { ChatMessage } from '@ai-cms/ai';
import {
  appendMessages,
  approveConversationDependencies,
  createConversation,
  GatewayError,
  getOwnConversation,
  streamAgentRun,
  type AgentRunOptions,
  type Conversation,
  type RunnerStreamEvent,
} from '@ai-cms/ai-config';
import { writeAudit } from '@ai-cms/audit';
import { devAgentProfile, requireAuthorized, type NodeTarget, type Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import { enqueue, isChangesetId } from '@ai-cms/pipeline';
import { eq } from 'drizzle-orm';
import { gateway } from './ai.ts';
import { sseResponse, historyOf, type ChatOwner } from './chat.ts';
import { db } from './db.ts';
import { BadRequestError } from './errors.ts';

export const DEV_AGENT = 'dev-agent';

/** What opening a changeset touches, for the authz check: the code of the site. */
const CODE: NodeTarget = { path: 'code', kind: 'folder', storage: 'git' };

const TITLE_LENGTH = 80;
const MAX_TITLE_LENGTH = 200;
const MAX_PACKAGES = 20;

/** Statuses in which the agent may still add work to the branch. */
const EDITABLE = new Set(['draft', 'checks_failed']);

/** The user seen through the developer-agent profile, which is what the changeset is worth. */
function asDeveloper(principal: Principal): Principal {
  return { ...principal, agent: devAgentProfile };
}

export interface StartedChangeset {
  conversationId: string;
  jobId: number | null;
}

/**
 * "Nuova modifica": asks the worker for a changeset of the person (its clone and database live
 * with the worker). The chat is opened first, so the changeset is born tied to it and the
 * widget finds it by its conversation. Only staging: `authz` refuses the developer agent in
 * production (I5).
 */
export async function startDevChangeset(
  principal: Principal,
  env: ChatOwner['env'],
  input: { title: string; description?: string | null },
): Promise<StartedChangeset> {
  requireAuthorized(asDeveloper(principal), 'write', CODE, env);
  const title = input.title.trim();
  if (!title) throw new BadRequestError('Dai un titolo alla modifica.');
  if (title.length > MAX_TITLE_LENGTH) throw new BadRequestError('Il titolo è troppo lungo.');

  const conversationId = await createConversation(db(), {
    uid: principal.uid,
    env,
    agent: DEV_AGENT,
    nodeId: null,
    title: title.slice(0, TITLE_LENGTH),
  });
  const jobId = await enqueue(
    db(),
    'changeset.create',
    {
      title,
      description: input.description?.trim() || null,
      authorUid: principal.uid,
      conversationId,
    },
    { dedupeKey: `changeset.create:${conversationId}`, maxAttempts: 1 },
  );
  await writeAudit(db(), {
    actorUid: principal.uid,
    action: 'changeset.request',
    env,
    outcome: 'ok',
    details: { conversationId, title, jobId },
  });
  return { conversationId, jobId };
}

export interface DevTurnInput {
  changesetId: string;
  message: string;
}

/** Tool failures that come from a permission, an invariant or the command allowlist. */
export function isDevBlocked(content: string): boolean {
  return /^(Permesso negato|Comando non consentito|Percorso non consentito|Accesso negato)/.test(
    content,
  );
}

/** The agent asked for a package the person has not approved. */
export function isDependencyDenial(content: string): boolean {
  return /dipendenz|pacchett/i.test(content) && /(approv|conferma)/i.test(content);
}

function sessionIdOf(conversation: Conversation): string | undefined {
  for (const row of [...conversation.messages].reverse()) {
    if (row.role !== 'system') continue;
    const part = (row.content as { type?: string; sessionId?: string }[] | null)?.[0];
    if (part?.type === 'claude-session' && part.sessionId) return part.sessionId;
  }
  return undefined;
}

/** Native engine or the CLI of a subscription, as assigned to the role in the AI tab. */
async function engineOf(uid: number): Promise<'native' | 'claude-code'> {
  try {
    await gateway().resolve({ uid, role: DEV_AGENT });
    return 'native';
  } catch (err) {
    if (err instanceof GatewayError && err.code === 'cli_engine') return 'claude-code';
    throw err;
  }
}

/** Loads the changeset a person may talk about: theirs, in staging, still open for work. */
async function loadWorkingChangeset(owner: ChatOwner, changesetId: string) {
  if (!isChangesetId(changesetId)) throw new BadRequestError('Id di changeset non valido.');
  const [changeset] = await db()
    .select()
    .from(schema.changesets)
    .where(eq(schema.changesets.id, changesetId));
  if (!changeset) throw new BadRequestError('Modifica non trovata.');
  if (!changeset.conversationId) {
    throw new BadRequestError('Questa modifica non ha una conversazione: aprine una nuova.');
  }
  const conversation = await getOwnConversation(db(), changeset.conversationId, owner);
  if (!conversation || conversation.agent !== DEV_AGENT) {
    throw new BadRequestError('Questa modifica è di un’altra persona.');
  }
  if (!EDITABLE.has(changeset.status)) {
    throw new BadRequestError(
      `La modifica è in stato «${changeset.status}»: l’agente non può più cambiarla.`,
    );
  }
  return { changeset, conversation };
}

/** One runner event as the events of the chat tab; `null` when the tab has nothing to show. */
export function toChatEvent(event: RunnerStreamEvent): ChatStreamEvent | null {
  switch (event.type) {
    case 'step':
      return { type: 'status', state: 'thinking' };
    case 'text_delta':
      return typeof event.text === 'string' ? { type: 'text', text: event.text } : null;
    case 'tool_call':
      return {
        type: 'tool_start',
        id: String(event.id),
        name: String(event.name),
        label: toolLabel(String(event.name)),
      };
    case 'tool_result': {
      const content = String(event.content ?? '');
      const failed = event.isError === true;
      return {
        type: 'tool_end',
        id: String(event.toolCallId),
        name: String(event.name),
        ok: !failed,
        blocked: failed && isDevBlocked(content),
        ...(failed ? { detail: content } : {}),
      };
    }
    case 'commit':
      return {
        type: 'commit',
        commit: String(event.commit),
        files: Array.isArray(event.files) ? event.files.map(String) : [],
      };
    default:
      return null;
  }
}

async function devTurn(
  owner: ChatOwner,
  input: DevTurnInput,
  signal: AbortSignal,
  emit: (event: ChatStreamEvent) => void,
  runner: AgentRunOptions,
): Promise<void> {
  if (owner.env !== 'staging') {
    throw new BadRequestError('L’agente sviluppatore lavora solo in staging.');
  }
  const { changeset, conversation } = await loadWorkingChangeset(owner, input.changesetId);
  const engine = await engineOf(owner.uid);
  emit({ type: 'conversation', id: conversation.id, title: conversation.title });
  emit({ type: 'status', state: 'thinking' });

  const history = historyOf(conversation);
  const userText = [...history.notes.map((note) => `[${note}]`), input.message].join('\n\n');
  await appendMessages(db(), conversation.id, [
    { role: 'user', content: [{ type: 'text', text: userText }] },
  ]);

  const resumeSessionId = engine === 'claude-code' ? sessionIdOf(conversation) : undefined;
  let stopReason = 'error';
  let failure: string | null = null;
  let committed = false;
  let sawDependencyDenial = false;
  let produced: ChatMessage[] = [];
  let assistantText = '';
  let sessionId: string | undefined;

  for await (const event of streamAgentRun(
    db(),
    {
      session: {
        uid: owner.uid,
        agent: DEV_AGENT,
        env: 'staging',
        changesetId: changeset.id,
        conversationId: conversation.id,
        // Read from the conversation, where only the person's own "Conferma" can write.
        approvedDependencies: conversation.approvedDependencies,
      },
      engine,
      prompt: userText,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(engine === 'native' ? { messages: history.messages } : {}),
    },
    { ...runner, signal },
  )) {
    const mapped = toChatEvent(event);
    if (mapped) {
      emit(mapped);
      if (mapped.type === 'tool_start') emit({ type: 'status', state: 'working' });
      if (mapped.type === 'commit') committed = true;
      if (mapped.type === 'tool_end' && !mapped.ok && mapped.detail) {
        if (isDependencyDenial(mapped.detail) && !sawDependencyDenial) {
          sawDependencyDenial = true;
          emit({ type: 'dependency', detail: mapped.detail });
        }
      }
    }
    if (event.type === 'text_delta' && typeof event.text === 'string') assistantText += event.text;
    if (event.type === 'error') failure = String(event.message);
    if (event.type === 'result') {
      stopReason = String(event.stopReason ?? 'end_turn');
      if (Array.isArray(event.messages)) produced = event.messages as ChatMessage[];
      if (typeof event.sessionId === 'string') sessionId = event.sessionId;
      if (event.stopReason === 'error' && typeof event.detail === 'string') failure = event.detail;
      if (event.rateLimited) {
        failure = 'Il limite dell’abbonamento è stato raggiunto: riprova più tardi.';
      }
    }
  }

  if (produced.length > 0) {
    await appendMessages(
      db(),
      conversation.id,
      produced.map((message) => ({
        role:
          message.role === 'assistant'
            ? 'assistant'
            : message.content.every((part) => part.type === 'tool_result')
              ? 'tool'
              : 'user',
        content: message.content,
      })),
    );
  } else if (assistantText) {
    await appendMessages(db(), conversation.id, [
      { role: 'assistant', content: [{ type: 'text', text: assistantText }] },
    ]);
  }
  if (sessionId) {
    await appendMessages(db(), conversation.id, [
      { role: 'system', content: [{ type: 'claude-session', sessionId }] },
    ]);
  }
  // The agent's work is checked on the server, whatever the agent said about it.
  if (committed) {
    await enqueue(
      db(),
      'changeset.check',
      { changesetId: changeset.id },
      { dedupeKey: `changeset.check:${changeset.id}` },
    );
  }
  await writeAudit(db(), {
    actorUid: owner.uid,
    agent: DEV_AGENT,
    action: 'chat.dev.turn',
    env: 'staging',
    outcome: failure ? 'error' : 'ok',
    details: {
      changesetId: changeset.id,
      conversationId: conversation.id,
      engine,
      stopReason,
      committed,
      ...(failure ? { detail: failure } : {}),
    },
  });
  if (failure) emit({ type: 'error', message: failure });
  emit({ type: 'done', stopReason: failure ? 'error' : stopReason });
}

/** One turn of the chat with the developer agent, streamed as server-sent events. */
export function runDevChatTurn(
  owner: ChatOwner,
  input: DevTurnInput,
  signal: AbortSignal,
  runner: AgentRunOptions = {},
) {
  return sseResponse((emit) => devTurn(owner, input, signal, emit, runner));
}

/**
 * "Approva il pacchetto": the person's explicit consent to `pnpm add` of these packages in
 * this chat (FR-37). Every name must be one the command allowlist would accept, so no URL,
 * git source or path gets in.
 */
export async function approveDevDependencies(
  owner: ChatOwner,
  input: { conversationId: string; packages: string[] },
): Promise<string[]> {
  if (owner.env !== 'staging') {
    throw new BadRequestError('Le dipendenze si aggiungono solo in staging.');
  }
  const conversation = await getOwnConversation(db(), input.conversationId, owner);
  if (!conversation || conversation.agent !== DEV_AGENT) {
    throw new BadRequestError('Conversazione non trovata.');
  }
  const packages = [...new Set(input.packages.map((name) => name.trim()).filter(Boolean))];
  if (packages.length === 0) throw new BadRequestError('Indica almeno un pacchetto.');
  if (packages.length > MAX_PACKAGES) throw new BadRequestError('Troppi pacchetti insieme.');
  for (const name of packages) {
    const check = checkCommand(`pnpm add --ignore-scripts ${name}`, {
      approvedDependencies: [name],
    });
    if (!check.allowed || name.includes('@', 1)) {
      throw new BadRequestError(
        `«${name}» non è un nome di pacchetto valido: indica solo il nome, senza versione né indirizzi.`,
      );
    }
  }
  const approved = await approveConversationDependencies(db(), conversation.id, packages);
  await appendMessages(db(), conversation.id, [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: `La persona ha approvato l'aggiunta dei pacchetti: ${packages.join(', ')}`,
        },
      ],
    },
  ]);
  await writeAudit(db(), {
    actorUid: owner.uid,
    action: 'chat.dev.approve-dependencies',
    env: 'staging',
    outcome: 'ok',
    details: { conversationId: conversation.id, packages },
  });
  return approved;
}
