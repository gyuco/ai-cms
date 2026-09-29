/**
 * Opening a conversation from a content version (E9.5, FR-08): every content version already
 * carries the `conversationId` of the chat that produced it (`@ai-cms/content/service`
 * `ContentVersion.conversationId`, saved since E5.3/E9.1); this turns that id into the
 * conversation and its messages, for the widget to show when the user opens it from a version.
 */
import type { Env } from '@ai-cms/authz';
import { schema, type Database } from '@ai-cms/db';
import { and, asc, desc, eq } from 'drizzle-orm';

export type ConversationMessageRole = (typeof schema.messageRoles)[number];

export interface ConversationMessage {
  id: number;
  role: ConversationMessageRole;
  content: unknown;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  uid: number;
  agent: string;
  env: Env;
  /** Node the conversation started from (FR-08); null for conversations not tied to a page. */
  nodeId: string | null;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** In the order they were exchanged. */
  messages: ConversationMessage[];
}

/** The conversation and its messages, or null when the id is unknown. */
export async function getConversation(db: Database, id: string): Promise<Conversation | null> {
  const [row] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, id));
  if (!row) return null;
  const messages = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, id))
    .orderBy(asc(schema.messages.id));
  return {
    id: row.id,
    uid: row.uid,
    agent: row.agent,
    env: row.env as Env,
    nodeId: row.nodeId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConversationSummary {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenConversationInput {
  uid: number;
  env: Env;
  agent: string;
  nodeId: string | null;
  title: string | null;
}

/** A new conversation, owned by `uid`. The title is the first thing the user asked (FR-08). */
export async function createConversation(
  db: Database,
  input: OpenConversationInput,
): Promise<string> {
  const [row] = await db
    .insert(schema.conversations)
    .values({
      uid: input.uid,
      env: input.env,
      agent: input.agent,
      nodeId: input.nodeId,
      title: input.title,
    })
    .returning({ id: schema.conversations.id });
  return row!.id;
}

/**
 * A conversation of `uid` in `env`, or null. Conversations are private to who started them:
 * an id of somebody else's (or of the other environment) looks like an unknown one.
 */
export async function getOwnConversation(
  db: Database,
  id: string,
  owner: { uid: number; env: Env },
): Promise<Conversation | null> {
  if (!UUID.test(id)) return null;
  const conversation = await getConversation(db, id);
  if (!conversation || conversation.uid !== owner.uid || conversation.env !== owner.env) {
    return null;
  }
  return conversation;
}

/** The conversations of `uid` started from a node in `env`, most recently active first. */
export async function listNodeConversations(
  db: Database,
  owner: { uid: number; env: Env },
  nodeId: string,
  limit = 30,
): Promise<ConversationSummary[]> {
  return db
    .select({
      id: schema.conversations.id,
      title: schema.conversations.title,
      createdAt: schema.conversations.createdAt,
      updatedAt: schema.conversations.updatedAt,
    })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.uid, owner.uid),
        eq(schema.conversations.env, owner.env),
        eq(schema.conversations.nodeId, nodeId),
      ),
    )
    .orderBy(desc(schema.conversations.updatedAt))
    .limit(limit);
}

export interface NewMessage {
  role: ConversationMessageRole;
  content: unknown;
}

/** Appends messages in order and marks the conversation as active now. */
export async function appendMessages(
  db: Database,
  conversationId: string,
  newMessages: readonly NewMessage[],
): Promise<void> {
  if (newMessages.length === 0) return;
  await db
    .insert(schema.messages)
    .values(newMessages.map((m) => ({ conversationId, role: m.role, content: m.content })));
  await db
    .update(schema.conversations)
    .set({ updatedAt: new Date() })
    .where(eq(schema.conversations.id, conversationId));
}

/** Ties a conversation to the page it started from. */
export async function setConversationNode(
  db: Database,
  conversationId: string,
  nodeId: string,
): Promise<void> {
  await db
    .update(schema.conversations)
    .set({ nodeId })
    .where(eq(schema.conversations.id, conversationId));
}
