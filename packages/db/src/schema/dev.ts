import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity.ts';
import { ltree } from './types.ts';

export const changesetStatuses = [
  'draft',
  'checking',
  'checks_failed',
  'ready',
  'releasing',
  'released',
  'release_failed',
  'rejected',
  'rolled_back',
  'closed',
] as const;
export type ChangesetStatus = (typeof changesetStatuses)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** A set of code changes developed together in staging (TECHNICAL §8.1). */
export const changesets = pgTable(
  'changesets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    description: text('description'),
    branch: text('branch').notNull().unique(),
    baseCommit: text('base_commit').notNull(),
    headCommit: text('head_commit'),
    authorUid: integer('author_uid')
      .notNull()
      .references(() => users.uid),
    status: text('status', { enum: changesetStatuses }).notNull().default('draft'),
    touchedPaths: ltree('touched_paths')
      .array()
      .notNull()
      .default(sql`'{}'`),
    destructiveMigration: boolean('destructive_migration').notNull().default(false),
    /** Correction rounds the developer agent has been asked for after failed checks (FR-42). */
    autofixAttempts: integer('autofix_attempts').notNull().default(0),
    conversationId: uuid('conversation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('changesets_status_check', sql`${t.status} IN (${inList(changesetStatuses)})`),
    index('changesets_status_idx').on(t.status),
  ],
);

export const checkStatuses = ['queued', 'running', 'passed', 'failed', 'skipped'] as const;

export const checkRuns = pgTable(
  'check_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    changesetId: uuid('changeset_id')
      .notNull()
      .references(() => changesets.id, { onDelete: 'cascade' }),
    commit: text('commit').notNull(),
    checkName: text('check_name').notNull(),
    status: text('status', { enum: checkStatuses }).notNull().default('queued'),
    output: text('output'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check('check_runs_status_check', sql`${t.status} IN (${inList(checkStatuses)})`),
    index('check_runs_changeset_idx').on(t.changesetId, t.commit),
  ],
);

export const reviewDecisions = ['approved', 'rejected'] as const;

export const reviews = pgTable(
  'reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    changesetId: uuid('changeset_id')
      .notNull()
      .references(() => changesets.id, { onDelete: 'cascade' }),
    reviewerUid: integer('reviewer_uid')
      .notNull()
      .references(() => users.uid),
    decision: text('decision', { enum: reviewDecisions }).notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('reviews_decision_check', sql`${t.decision} IN (${inList(reviewDecisions)})`)],
);

export const releaseStatuses = ['pending', 'running', 'released', 'failed', 'rolled_back'] as const;

export const releases = pgTable(
  'releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: integer('number').notNull().unique(),
    changesetIds: uuid('changeset_ids').array().notNull(),
    commit: text('commit'),
    artifactPath: text('artifact_path'),
    backupPath: text('backup_path'),
    status: text('status', { enum: releaseStatuses }).notNull().default('pending'),
    approvedBy: integer('approved_by')
      .notNull()
      .references(() => users.uid),
    previousReleaseId: uuid('previous_release_id'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [check('releases_status_check', sql`${t.status} IN (${inList(releaseStatuses)})`)],
);
