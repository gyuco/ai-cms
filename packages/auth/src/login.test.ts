import { schema } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  changePassword,
  FREE_ATTEMPTS,
  issueTemporaryPassword,
  lockDuration,
  login,
} from './login.ts';
import { hashPassword } from './password.ts';
import { getSession } from './sessions.ts';

describe('lockDuration', () => {
  it('allows a few free attempts, then doubles up to one hour', () => {
    expect(lockDuration(FREE_ATTEMPTS - 1)).toBe(0);
    expect(lockDuration(FREE_ATTEMPTS)).toBe(60_000);
    expect(lockDuration(FREE_ATTEMPTS + 1)).toBe(120_000);
    expect(lockDuration(FREE_ATTEMPTS + 20)).toBe(3_600_000);
  });
});

describe.skipIf(!testDatabaseUrl)('login and sessions', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let uid: number;
  const password = 'una password lunga';

  beforeAll(async () => {
    database = await createTestDatabase();
    const [user] = await database.db
      .insert(schema.users)
      .values({
        username: 'anna',
        email: 'anna@example.com',
        passwordHash: await hashPassword(password),
        status: 'active',
      })
      .returning();
    uid = user!.uid;
  });

  beforeEach(async () => {
    await database.db
      .update(schema.users)
      .set({ failedLogins: 0, lockedUntil: null, status: 'active' })
      .where(eq(schema.users.uid, uid));
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('logs in by username or email and resolves the session', async () => {
    for (const identifier of ['anna', 'ANNA@example.com']) {
      const result = await login(database.db, identifier, password, { ip: '10.0.0.1' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const session = await getSession(database.db, result.token);
      expect(session?.user.uid).toBe(uid);
      expect(session?.csrfToken).toBe(result.csrfToken);
    }
  });

  it('never stores the raw session token', async () => {
    const result = await login(database.db, 'anna', password);
    if (!result.ok) throw new Error('login failed');
    const rows = await database.db.select().from(schema.sessions);
    expect(rows.some((r) => r.id === result.token)).toBe(false);
  });

  it('rejects wrong passwords and locks after repeated failures', async () => {
    for (let i = 0; i < FREE_ATTEMPTS - 1; i++) {
      expect(await login(database.db, 'anna', 'wrong')).toEqual({ ok: false, reason: 'invalid' });
    }
    const locked = await login(database.db, 'anna', 'wrong');
    expect(locked.ok === false && locked.reason).toBe('locked');
    // Even the right password is refused while locked.
    const stillLocked = await login(database.db, 'anna', password);
    expect(stillLocked.ok === false && stillLocked.reason).toBe('locked');
  });

  it('refuses suspended users and invalidates their sessions', async () => {
    const result = await login(database.db, 'anna', password);
    if (!result.ok) throw new Error('login failed');
    await database.db
      .update(schema.users)
      .set({ status: 'suspended' })
      .where(eq(schema.users.uid, uid));
    expect(await getSession(database.db, result.token)).toBeNull();
    expect(await login(database.db, 'anna', password)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects unknown users with the same answer as wrong passwords', async () => {
    expect(await login(database.db, 'nobody', password)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('changes the password and rotates every session', async () => {
    const first = await login(database.db, 'anna', password);
    if (!first.ok) throw new Error('login failed');
    const newPassword = "un'altra password lunga";

    expect(await changePassword(database.db, uid, 'wrong', newPassword)).toEqual({
      ok: false,
      reason: 'invalid_current',
    });
    expect(await changePassword(database.db, uid, password, 'short')).toEqual({
      ok: false,
      reason: 'too_short',
    });

    const changed = await changePassword(database.db, uid, password, newPassword);
    expect(changed.ok).toBe(true);
    expect(await getSession(database.db, first.token)).toBeNull();
    if (changed.ok) expect((await getSession(database.db, changed.token))?.user.uid).toBe(uid);
    expect((await login(database.db, 'anna', newPassword)).ok).toBe(true);
  });

  it('issues a temporary password that unlocks the account and must be changed', async () => {
    await database.db
      .update(schema.users)
      .set({ lockedUntil: new Date(Date.now() + 60_000), failedLogins: 9 })
      .where(eq(schema.users.uid, uid));
    const temporary = await issueTemporaryPassword(database.db, uid);
    const result = await login(database.db, 'anna', temporary);
    expect(result.ok && result.mustChangePassword).toBe(true);
  });
});
