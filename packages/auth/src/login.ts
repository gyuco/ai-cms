import { writeAudit } from '@ai-cms/audit';
import { schema, type Database } from '@ai-cms/db';
import { randomBytes } from 'node:crypto';
import { eq, or } from 'drizzle-orm';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './password.ts';
import { createSession, destroyUserSessions, type SessionMeta } from './sessions.ts';

// Failures before the account is locked; each further failure doubles the lock (max 1 hour).
export const FREE_ATTEMPTS = 5;
const MAX_LOCK_MS = 60 * 60 * 1000;

export function lockDuration(failedLogins: number): number {
  if (failedLogins < FREE_ATTEMPTS) return 0;
  return Math.min(60_000 * 2 ** (failedLogins - FREE_ATTEMPTS), MAX_LOCK_MS);
}

// Verified against when the user does not exist, so both paths take the same time.
let dummyHash: Promise<string> | undefined;

export type LoginResult =
  | {
      ok: true;
      token: string;
      csrfToken: string;
      expiresAt: Date;
      uid: number;
      mustChangePassword: boolean;
    }
  | { ok: false; reason: 'invalid' | 'locked'; lockedUntil?: Date };

/** Checks credentials (username or email) and opens a session. */
export async function login(
  db: Database,
  identifier: string,
  password: string,
  meta: SessionMeta = {},
): Promise<LoginResult> {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(or(eq(schema.users.username, identifier), eq(schema.users.email, identifier)));

  if (!user || !user.passwordHash || user.status !== 'active') {
    dummyHash ??= hashPassword('dummy password for timing');
    await verifyPassword(await dummyHash, password);
    await writeAudit(db, {
      actorUid: user?.uid ?? -1,
      action: 'auth.login',
      outcome: 'denied',
      details: { identifier, reason: user ? `status:${user.status}` : 'unknown user', ip: meta.ip },
    });
    return { ok: false, reason: 'invalid' };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await writeAudit(db, {
      actorUid: user.uid,
      action: 'auth.login',
      outcome: 'denied',
      details: { reason: 'locked', ip: meta.ip },
    });
    return { ok: false, reason: 'locked', lockedUntil: user.lockedUntil };
  }

  if (!(await verifyPassword(user.passwordHash, password))) {
    const failedLogins = user.failedLogins + 1;
    const lock = lockDuration(failedLogins);
    const lockedUntil = lock > 0 ? new Date(Date.now() + lock) : null;
    await db
      .update(schema.users)
      .set({ failedLogins, lockedUntil })
      .where(eq(schema.users.uid, user.uid));
    await writeAudit(db, {
      actorUid: user.uid,
      action: 'auth.login',
      outcome: 'denied',
      details: { reason: 'bad password', failedLogins, ip: meta.ip },
    });
    return lockedUntil
      ? { ok: false, reason: 'locked', lockedUntil }
      : { ok: false, reason: 'invalid' };
  }

  await db
    .update(schema.users)
    .set({ failedLogins: 0, lockedUntil: null })
    .where(eq(schema.users.uid, user.uid));
  const session = await createSession(db, user.uid, meta);
  await writeAudit(db, {
    actorUid: user.uid,
    action: 'auth.login',
    outcome: 'ok',
    details: { ip: meta.ip },
  });
  return { ok: true, ...session, uid: user.uid, mustChangePassword: user.mustChangePassword };
}

export type PasswordChangeResult =
  | { ok: true; token: string; csrfToken: string; expiresAt: Date }
  | { ok: false; reason: 'invalid_current' | 'too_short' | 'unchanged' };

/**
 * Changes a password after checking the current one. All sessions of the user are closed
 * and a fresh one is returned (session rotation on privilege change).
 */
export async function changePassword(
  db: Database,
  uid: number,
  currentPassword: string,
  newPassword: string,
  meta: SessionMeta = {},
): Promise<PasswordChangeResult> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'too_short' };
  if (newPassword === currentPassword) return { ok: false, reason: 'unchanged' };
  const [user] = await db.select().from(schema.users).where(eq(schema.users.uid, uid));
  if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
    return { ok: false, reason: 'invalid_current' };
  }
  await setPassword(db, uid, newPassword);
  const session = await createSession(db, uid, meta);
  await writeAudit(db, { actorUid: uid, action: 'auth.password_change', outcome: 'ok' });
  return { ok: true, ...session };
}

/** Sets a new password, activates invited users and closes every existing session. */
export async function setPassword(db: Database, uid: number, newPassword: string): Promise<void> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.uid, uid));
  await db
    .update(schema.users)
    .set({
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      failedLogins: 0,
      lockedUntil: null,
      status: user?.status === 'invited' ? 'active' : user?.status,
      updatedAt: new Date(),
    })
    .where(eq(schema.users.uid, uid));
  await destroyUserSessions(db, uid);
}

/**
 * Replaces a user's password with a random temporary one that must be changed at the next
 * login, unlocks the account and closes its sessions. Used to recover access (e.g. root).
 */
export async function issueTemporaryPassword(db: Database, uid: number): Promise<string> {
  const password = randomBytes(18).toString('base64url');
  await db
    .update(schema.users)
    .set({
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
      failedLogins: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.users.uid, uid));
  await destroyUserSessions(db, uid);
  await writeAudit(db, { actorUid: uid, action: 'auth.temporary_password', outcome: 'ok' });
  return password;
}
