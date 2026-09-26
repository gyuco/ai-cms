import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity.ts';
import { nodes } from './tree.ts';

/** A chat with an agent, started from a page (FR-08). */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uid: integer('uid')
      .notNull()
      .references(() => users.uid),
    agent: text('agent').notNull(),
    env: text('env').notNull(),
    nodeId: uuid('node_id').references(() => nodes.id),
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('conversations_env_check', sql`${t.env} IN ('prod', 'staging')`),
    index('conversations_uid_idx').on(t.uid, t.updatedAt),
    index('conversations_node_idx').on(t.nodeId),
  ],
);

export const messageRoles = ['user', 'assistant', 'tool', 'system'] as const;

export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: messageRoles }).notNull(),
    content: jsonb('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('messages_role_check', sql`${t.role} IN ('user', 'assistant', 'tool', 'system')`),
    index('messages_conversation_idx').on(t.conversationId, t.id),
  ],
);

export const usageKinds = ['api', 'subscription', 'local'] as const;

/** One row per model call, for the usage dashboard and spend limits (FR-129, FR-130). */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    uid: integer('uid')
      .notNull()
      .references(() => users.uid),
    role: text('role').notNull(),
    connection: text('connection').notNull(),
    model: text('model').notNull(),
    kind: text('kind', { enum: usageKinds }).notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costEstimate: numeric('cost_estimate', { precision: 12, scale: 6 }),
    outcome: text('outcome').notNull(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ai_usage_kind_check', sql`${t.kind} IN ('api', 'subscription', 'local')`),
    index('ai_usage_uid_created_idx').on(t.uid, t.createdAt),
  ],
);
