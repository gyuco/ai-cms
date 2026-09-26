import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { citext } from './types.ts';

export const userKinds = ['human', 'service', 'agent'] as const;
export const userStatuses = ['invited', 'active', 'suspended', 'deleted'] as const;

/** uid 0 is root and uid 1 is the system user; regular users start at 1000. */
export const users = pgTable(
  'users',
  {
    uid: integer('uid').primaryKey().generatedByDefaultAsIdentity({ startWith: 1000 }),
    username: citext('username').notNull().unique(),
    email: citext('email').notNull().unique(),
    displayName: text('display_name'),
    passwordHash: text('password_hash'),
    kind: text('kind', { enum: userKinds }).notNull().default('human'),
    status: text('status', { enum: userStatuses }).notNull().default('invited'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('users_kind_check', sql`${t.kind} IN ('human', 'service', 'agent')`),
    check('users_status_check', sql`${t.status} IN ('invited', 'active', 'suspended', 'deleted')`),
  ],
);

/** Server-side sessions. `id` is the SHA-256 of the session token; the token itself is never stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    uid: integer('uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_uid_idx').on(t.uid), index('sessions_expires_at_idx').on(t.expiresAt)],
);
