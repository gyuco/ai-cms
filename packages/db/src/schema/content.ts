import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  bigint,
} from 'drizzle-orm/pg-core';
import { users } from './identity.ts';
import { nodes } from './tree.ts';

export const contentEnvs = ['prod', 'staging'] as const;
export const publicationStatuses = ['published', 'scheduled', 'archived'] as const;
export type ContentEnv = (typeof contentEnvs)[number];

/** Every save creates a new immutable version (FR-60). `body` holds blocks and metadata. */
export const contentVersions = pgTable(
  'content_versions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id),
    env: text('env', { enum: contentEnvs }).notNull(),
    version: integer('version').notNull(),
    body: jsonb('body').notNull(),
    authorUid: integer('author_uid')
      .notNull()
      .references(() => users.uid),
    viaAgent: text('via_agent'),
    conversationId: uuid('conversation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('content_versions_node_env_version_key').on(t.nodeId, t.env, t.version),
    check('content_versions_env_check', sql`${t.env} IN ('prod', 'staging')`),
  ],
);

/** The version currently visible on the site for a node and environment. */
export const publications = pgTable(
  'publications',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id),
    env: text('env', { enum: contentEnvs }).notNull(),
    versionId: bigint('version_id', { mode: 'number' })
      .notNull()
      .references(() => contentVersions.id),
    status: text('status', { enum: publicationStatuses }).notNull(),
    publishAt: timestamp('publish_at', { withTimezone: true }),
    publishedBy: integer('published_by')
      .notNull()
      .references(() => users.uid),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.nodeId, t.env] }),
    check('publications_env_check', sql`${t.env} IN ('prod', 'staging')`),
    check('publications_status_check', sql`${t.status} IN ('published', 'scheduled', 'archived')`),
    index('publications_scheduled_idx')
      .on(t.publishAt)
      .where(sql`${t.status} = 'scheduled'`),
  ],
);
