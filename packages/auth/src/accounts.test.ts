import { schema } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  inviteUser,
  requestPasswordReset,
  setPasswordWithToken,
  signOnWithToken,
} from './accounts.ts';
import { issueAuthToken, peekAuthToken } from './auth-tokens.ts';
import { login } from './login.ts';
import type { Mail } from './mail.ts';
import { getSession } from './sessions.ts';

const SITE = 'http://www.localhost';

function tokenFrom(mail: Mail | undefined): string {
  const match = mail?.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('no token in mail');
  return match[1]!;
}

describe.skipIf(!testDatabaseUrl)('accounts', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const outbox: Mail[] = [];
  const mailer = async (mail: Mail) => {
    outbox.push(mail);
  };

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('invites a user who then sets a password and is signed in', async () => {
    const result = await inviteUser(
      database.db,
      mailer,
      0,
      { username: 'luca', email: 'luca@example.com', displayName: 'Luca' },
      SITE,
    );
    expect(result.ok).toBe(true);
    const mail = outbox.at(-1);
    expect(mail?.to).toBe('luca@example.com');
    expect(mail?.text).toContain(`${SITE}/_cms/invite?token=`);

    const token = tokenFrom(mail);
    expect(await peekAuthToken(database.db, token, 'invite')).not.toBeNull();
    // An invited user cannot log in before accepting.
    expect((await login(database.db, 'luca', 'whatever')).ok).toBe(false);

    const accepted = await setPasswordWithToken(
      database.db,
      token,
      'invite',
      'la mia password sicura',
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok)
      expect((await getSession(database.db, accepted.token))?.user.username).toBe('luca');

    // Single use.
    expect(await setPasswordWithToken(database.db, token, 'invite', 'un altra password')).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
    expect((await login(database.db, 'luca', 'la mia password sicura')).ok).toBe(true);
  });

  it('rejects duplicate and malformed invitations', async () => {
    const invite = (username: string, email: string) =>
      inviteUser(database.db, mailer, 0, { username, email }, SITE);
    expect(await invite('LUCA', 'new@example.com')).toEqual({ ok: false, reason: 'exists' });
    expect(await invite('x', 'x@example.com')).toEqual({ ok: false, reason: 'invalid_username' });
    expect(await invite('marta', 'not-an-email')).toEqual({ ok: false, reason: 'invalid_email' });
  });

  it('resets a password by email and stays silent for unknown addresses', async () => {
    const before = outbox.length;
    await requestPasswordReset(database.db, mailer, 'nobody@example.com', SITE);
    expect(outbox.length).toBe(before);

    await requestPasswordReset(database.db, mailer, 'luca@example.com', SITE);
    const token = tokenFrom(outbox.at(-1));
    expect(await setPasswordWithToken(database.db, token, 'reset', 'corta')).toEqual({
      ok: false,
      reason: 'too_short',
    });
    const reset = await setPasswordWithToken(
      database.db,
      token,
      'reset',
      'password nuova di zecca',
    );
    expect(reset.ok).toBe(true);
    expect((await login(database.db, 'luca', 'password nuova di zecca')).ok).toBe(true);
  });

  it('does not accept a token for a different purpose or after expiry', async () => {
    const [luca] = await database.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, 'luca'));
    const sso = await issueAuthToken(database.db, luca!.uid, 'sso');
    expect(
      await setPasswordWithToken(database.db, sso, 'reset', 'password nuova di zecca'),
    ).toEqual({ ok: false, reason: 'invalid_token' });

    await database.db
      .update(schema.authTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.authTokens.uid, luca!.uid));
    expect(await signOnWithToken(database.db, sso)).toBeNull();
  });

  it('signs on with a fresh SSO token exactly once', async () => {
    const [luca] = await database.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, 'luca'));
    const token = await issueAuthToken(database.db, luca!.uid, 'sso');
    const session = await signOnWithToken(database.db, token);
    expect(session).not.toBeNull();
    expect(await signOnWithToken(database.db, token)).toBeNull();
  });
});
