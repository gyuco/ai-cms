import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { users } from './identity.ts';
import { ltree } from './types.ts';

export const nodeKinds = [
  'dir',
  'page',
  'layout',
  'menu',
  'asset',
  'collection',
  'file',
  'setting',
  'secret',
  'agent',
] as const;
export const nodeStorages = ['db', 'git', 's3', 'virtual'] as const;
export const nodeEnvs = ['prod', 'staging', 'both'] as const;

export type NodeKind = (typeof nodeKinds)[number];
export type NodeStorage = (typeof nodeStorages)[number];
export type NodeEnv = (typeof nodeEnvs)[number];

/**
 * The CMS tree (TECHNICAL §5.2). `path` mirrors the names from the root, e.g. /site/pages/blog
 * is `site.pages.blog`; the root node has an empty path. Permission columns arrive in phase 2.
 */
export const nodes = pgTable(
  'nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentId: uuid('parent_id').references((): AnyPgColumn => nodes.id),
    name: text('name').notNull(),
    path: ltree('path').notNull(),
    kind: text('kind', { enum: nodeKinds }).notNull(),
    storage: text('storage', { enum: nodeStorages }).notNull().default('db'),
    env: text('env', { enum: nodeEnvs }).notNull().default('both'),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.uid),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('nodes_path_live_idx')
      .on(t.path)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('nodes_parent_name_live_idx')
      .on(t.parentId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    index('nodes_path_gist_idx').using('gist', t.path),
    index('nodes_parent_idx').on(t.parentId),
    check(
      'nodes_name_check',
      sql`(${t.parentId} IS NULL AND ${t.name} = '') OR ${t.name} ~ '^[a-z0-9][a-z0-9_-]{0,62}$'`,
    ),
    check(
      'nodes_kind_check',
      sql`${t.kind} IN (${sql.raw(nodeKinds.map((k) => `'${k}'`).join(', '))})`,
    ),
    check('nodes_storage_check', sql`${t.storage} IN ('db', 'git', 's3', 'virtual')`),
    check('nodes_env_check', sql`${t.env} IN ('prod', 'staging', 'both')`),
  ],
);
