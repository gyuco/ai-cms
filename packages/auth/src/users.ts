import { writeAudit } from '@ai-cms/audit';
import { ROOT_UID, schema, type Database } from '@ai-cms/db';
import { and, asc, eq } from 'drizzle-orm';
import { destroyUserSessions } from './sessions.ts';

export interface UserSummary {
  uid: number;
  username: string;
  displayName: string | null;
  email: string;
  status: 'invited' | 'active' | 'suspended' | 'deleted';
  createdAt: Date;
}

/** People who can sign in (FR-70); service and agent accounts are not listed. */
export async function listUsers(db: Database): Promise<UserSummary[]> {
  return db
    .select({
      uid: schema.users.uid,
      username: schema.users.username,
      displayName: schema.users.displayName,
      email: schema.users.email,
      status: schema.users.status,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .where(eq(schema.users.kind, 'human'))
    .orderBy(asc(schema.users.uid));
}

export type UserStatusChangeResult =
  | { ok: true; status: UserSummary['status'] }
  | { ok: false; reason: 'not_found' | 'self' | 'root' | 'not_suspendable' | 'not_suspended' };

async function loadHuman(db: Database, uid: number) {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.uid, uid), eq(schema.users.kind, 'human')));
  return user && user.status !== 'deleted' ? user : null;
}

/**
 * Suspends a user and closes all their sessions (FR-70). Nobody can suspend themselves or
 * root: the platform must always keep an administrator who can sign in.
 */
export async function suspendUser(
  db: Database,
  actorUid: number,
  uid: number,
): Promise<UserStatusChangeResult> {
  if (uid === actorUid) return { ok: false, reason: 'self' };
  if (uid === ROOT_UID) return { ok: false, reason: 'root' };
  const user = await loadHuman(db, uid);
  if (!user) return { ok: false, reason: 'not_found' };
  if (user.status === 'suspended') return { ok: false, reason: 'not_suspendable' };

  await db.transaction(async (tx) => {
    await tx
      .update(schema.users)
      .set({ status: 'suspended', updatedAt: new Date() })
      .where(eq(schema.users.uid, uid));
    await writeAudit(tx, {
      actorUid,
      action: 'user.suspend',
      outcome: 'ok',
      details: { uid, username: user.username, previousStatus: user.status },
    });
  });
  await destroyUserSessions(db, uid);
  return { ok: true, status: 'suspended' };
}

/**
 * Lifts a suspension. A user who never set a password goes back to "invited" and can still
 * use a valid invitation link.
 */
export async function reactivateUser(
  db: Database,
  actorUid: number,
  uid: number,
): Promise<UserStatusChangeResult> {
  const user = await loadHuman(db, uid);
  if (!user) return { ok: false, reason: 'not_found' };
  if (user.status !== 'suspended') return { ok: false, reason: 'not_suspended' };
  const status = user.passwordHash ? 'active' : 'invited';

  await db.transaction(async (tx) => {
    await tx
      .update(schema.users)
      .set({ status, failedLogins: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(schema.users.uid, uid));
    await writeAudit(tx, {
      actorUid,
      action: 'user.reactivate',
      outcome: 'ok',
      details: { uid, username: user.username, status },
    });
  });
  return { ok: true, status };
}
