import { writeAudit } from '@ai-cms/audit';
import { schema, type Database } from '@ai-cms/db';
import { eq, or } from 'drizzle-orm';
import { consumeAuthToken, issueAuthToken } from './auth-tokens.ts';
import { setPassword } from './login.ts';
import type { Mailer } from './mail.ts';
import { MIN_PASSWORD_LENGTH } from './password.ts';
import { createSession, type SessionMeta } from './sessions.ts';

export interface InviteInput {
  username: string;
  email: string;
  displayName?: string | null;
}

export type InviteResult =
  | { ok: true; uid: number }
  | { ok: false; reason: 'invalid_username' | 'invalid_email' | 'exists' };

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** Creates an invited user and emails a link to set the password (FR-71). */
export async function inviteUser(
  db: Database,
  mailer: Mailer,
  invitedBy: number,
  input: InviteInput,
  siteUrl: string,
): Promise<InviteResult> {
  const username = input.username.trim();
  const email = input.email.trim();
  if (!USERNAME.test(username)) return { ok: false, reason: 'invalid_username' };
  if (!EMAIL.test(email)) return { ok: false, reason: 'invalid_email' };

  const [existing] = await db
    .select({ uid: schema.users.uid })
    .from(schema.users)
    .where(or(eq(schema.users.username, username), eq(schema.users.email, email)));
  if (existing) return { ok: false, reason: 'exists' };

  const [user] = await db
    .insert(schema.users)
    .values({ username, email, displayName: input.displayName?.trim() || null, status: 'invited' })
    .returning({ uid: schema.users.uid });
  const token = await issueAuthToken(db, user!.uid, 'invite');
  await mailer({
    to: email,
    subject: 'Invito al CMS',
    text: [
      `Ciao ${input.displayName?.trim() || username},`,
      '',
      'sei stato invitato a gestire il sito. Scegli la tua password da questo link',
      '(valido 7 giorni):',
      '',
      `${siteUrl}/_cms/invite?token=${token}`,
    ].join('\n'),
  });
  await writeAudit(db, {
    actorUid: invitedBy,
    action: 'user.invite',
    outcome: 'ok',
    details: { uid: user!.uid, username },
  });
  return { ok: true, uid: user!.uid };
}

/**
 * Sends a reset link if an active user has this email. The caller always answers the same
 * way, so the endpoint does not reveal which addresses exist.
 */
export async function requestPasswordReset(
  db: Database,
  mailer: Mailer,
  email: string,
  siteUrl: string,
): Promise<void> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email.trim()));
  if (!user || user.status !== 'active') return;
  const token = await issueAuthToken(db, user.uid, 'reset');
  await mailer({
    to: user.email,
    subject: 'Reimposta la password',
    text: [
      'Hai chiesto di reimpostare la password. Usa questo link (valido 1 ora):',
      '',
      `${siteUrl}/_cms/reset?token=${token}`,
      '',
      'Se non sei stato tu, ignora questa email.',
    ].join('\n'),
  });
  await writeAudit(db, { actorUid: user.uid, action: 'auth.reset_request', outcome: 'ok' });
}

export type TokenPasswordResult =
  | { ok: true; token: string; csrfToken: string; expiresAt: Date }
  | { ok: false; reason: 'invalid_token' | 'too_short' };

/** Sets the password from an invite or reset link and signs the user in. */
export async function setPasswordWithToken(
  db: Database,
  token: string,
  purpose: 'invite' | 'reset',
  newPassword: string,
  meta: SessionMeta = {},
): Promise<TokenPasswordResult> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'too_short' };
  const uid = await consumeAuthToken(db, token, purpose);
  if (uid === null) return { ok: false, reason: 'invalid_token' };
  await setPassword(db, uid, newPassword);
  const session = await createSession(db, uid, meta);
  await writeAudit(db, {
    actorUid: uid,
    action: purpose === 'invite' ? 'auth.invite_accept' : 'auth.reset',
    outcome: 'ok',
  });
  return { ok: true, ...session };
}

/** Exchanges a single-use SSO token for a session on the other environment's host (E3.5). */
export async function signOnWithToken(db: Database, token: string, meta: SessionMeta = {}) {
  const uid = await consumeAuthToken(db, token, 'sso');
  if (uid === null) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.uid, uid));
  if (!user || user.status !== 'active') return null;
  return createSession(db, uid, meta);
}
