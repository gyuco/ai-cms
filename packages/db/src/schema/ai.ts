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
import { changesets } from './dev.ts';
import { ltree } from './types.ts';

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
    /** Packages the person approved in this chat for `pnpm add` (FR-37); only they can add to it. */
    approvedDependencies: text('approved_dependencies')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
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

export const connectionTypes = ['api', 'subscription', 'local'] as const;
export const connectionProviders = ['anthropic', 'openai-compatible', 'claude-code'] as const;

/** A way to reach a model provider (TECHNICAL §7.7). */
export const aiConnections = pgTable(
  'ai_connections',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    type: text('type', { enum: connectionTypes }).notNull(),
    provider: text('provider', { enum: connectionProviders }).notNull(),
    baseUrl: text('base_url'),
    defaultModel: text('default_model'),
    /** Name in `secrets` for API keys; null for subscriptions and keyless local servers. */
    secretName: text('secret_name'),
    /** Set for personal connections (FR-128); null means shared. */
    ownerUid: integer('owner_uid').references(() => users.uid),
    config: jsonb('config').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ai_connections_type_check', sql`${t.type} IN ('api', 'subscription', 'local')`),
    check(
      'ai_connections_provider_check',
      sql`${t.provider} IN ('anthropic', 'openai-compatible', 'claude-code')`,
    ),
  ],
);

/** Which connection and model each AI role uses; phase 1 uses one connection for all. */
export const aiRoles = pgTable('ai_roles', {
  role: text('role').primaryKey(),
  connectionId: text('connection_id')
    .notNull()
    .references(() => aiConnections.id),
  model: text('model'),
  fallback: jsonb('fallback').notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Short-lived credentials for an agent run (MCP server, AI gateway). They carry the
 * principal the agent acts for (TECHNICAL §7.3). `id` is the SHA-256 of the token.
 */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: text('id').primaryKey(),
    uid: integer('uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    agent: text('agent').notNull(),
    env: text('env').notNull(),
    scope: ltree('scope').array(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    changesetId: uuid('changeset_id').references(() => changesets.id, { onDelete: 'cascade' }),
    /** Package names the user approved in the chat for `pnpm add` (FR-37); empty by default. */
    approvedDependencies: text('approved_dependencies')
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('agent_sessions_env_check', sql`${t.env} IN ('prod', 'staging')`),
    index('agent_sessions_expires_idx').on(t.expiresAt),
  ],
);
