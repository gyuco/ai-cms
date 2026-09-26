import { schema, type Database } from '@ai-cms/db';
import { and, eq, gt, lt } from 'drizzle-orm';
import { generateToken, hashToken } from './tokens.ts';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Sliding expiry: extend at most once per hour of activity.
const RENEW_AFTER_MS = 60 * 60 * 1000;

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface SessionUser {
  uid: number;
  username: string;
  displayName: string | null;
  email: string;
  mustChangePassword: boolean;
}

export interface ActiveSession {
  id: string;
  csrfToken: string;
  expiresAt: Date;
  user: SessionUser;
}

export async function createSession(db: Database, uid: number, meta: SessionMeta = {}) {
  const token = generateToken();
  const csrfToken = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({
    id: hashToken(token),
    uid,
    csrfToken,
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  return { token, csrfToken, expiresAt };
}

/** Returns the session for a token if it is valid and its user is active. */
export async function getSession(db: Database, token: string): Promise<ActiveSession | null> {
  const id = hashToken(token);
  const now = new Date();
  const [row] = await db
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.uid, schema.sessions.uid))
    .where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, now)));
  if (!row || row.user.status !== 'active') return null;

  let expiresAt = row.session.expiresAt;
  if (now.getTime() - row.session.lastSeenAt.getTime() > RENEW_AFTER_MS) {
    expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await db
      .update(schema.sessions)
      .set({ lastSeenAt: now, expiresAt })
      .where(eq(schema.sessions.id, id));
  }

  return {
    id,
    csrfToken: row.session.csrfToken,
    expiresAt,
    user: {
      uid: row.user.uid,
      username: row.user.username,
      displayName: row.user.displayName,
      email: row.user.email,
      mustChangePassword: row.user.mustChangePassword,
    },
  };
}

export async function destroySession(db: Database, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, hashToken(token)));
}

/** Logs a user out everywhere, e.g. after a password change or suspension. */
export async function destroyUserSessions(db: Database, uid: number): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.uid, uid));
}

export async function deleteExpiredSessions(db: Database): Promise<void> {
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
}
