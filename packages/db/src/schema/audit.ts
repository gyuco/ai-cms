import { bigserial, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { ltree } from './types.ts';

/**
 * Append-only audit log (TECHNICAL §5.5). Each row's `hash` is sha256(prev_hash + row),
 * so any later change breaks the chain. UPDATE, DELETE and TRUNCATE are blocked by triggers.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true, mode: 'string' }).notNull(),
    actorUid: integer('actor_uid').notNull(),
    agent: text('agent'),
    action: text('action').notNull(),
    nodePath: ltree('node_path'),
    env: text('env'),
    outcome: text('outcome').notNull(),
    details: jsonb('details'),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    index('audit_log_actor_idx').on(t.actorUid, t.at),
    index('audit_log_action_idx').on(t.action, t.at),
    index('audit_log_node_path_gist_idx').using('gist', t.nodePath),
  ],
);
