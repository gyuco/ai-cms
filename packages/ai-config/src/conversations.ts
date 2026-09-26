/**
 * Opening a conversation from a content version (E9.5, FR-08): every content version already
 * carries the `conversationId` of the chat that produced it (`@ai-cms/content/service`
 * `ContentVersion.conversationId`, saved since E5.3/E9.1); this turns that id into the
 * conversation and its messages, for the widget to show when the user opens it from a version.
 */
import type { Env } from '@ai-cms/authz';
import { schema, type Database } from '@ai-cms/db';
import { asc, eq } from 'drizzle-orm';

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
