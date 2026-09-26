import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const jobStatuses = ['queued', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof jobStatuses)[number];

/**
 * Background job queue (TECHNICAL §8). Workers claim rows with FOR UPDATE SKIP LOCKED;
 * inserts NOTIFY the `jobs` channel so idle workers wake up immediately.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status', { enum: jobStatuses }).notNull().default('queued'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),
    result: jsonb('result'),
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check('jobs_status_check', sql`${t.status} IN ('queued', 'running', 'done', 'failed')`),
    index('jobs_ready_idx')
      .on(t.runAt)
      .where(sql`${t.status} = 'queued'`),
    index('jobs_type_idx').on(t.type, t.status),
  ],
);
