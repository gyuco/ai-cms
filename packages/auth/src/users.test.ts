import { schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from './password.ts';
import { createSession, getSession } from './sessions.ts';
import { listUsers, reactivateUser, suspendUser } from './users.ts';

describe.skipIf(!testDatabaseUrl)('user administration', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
    await database.db.insert(schema.users).values([
      {
        uid: 1000,
        username: 'anna',
        email: 'anna@x.test',
        displayName: 'Anna',
        status: 'active',
        passwordHash: await hashPassword('password-lunga'),
      },
      { uid: 1001, username: 'bruno', email: 'bruno@x.test', status: 'invited' },
    ]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  async function lastAudit() {
    const [row] = await db()
      .select()
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.id))
      .limit(1);
    return row!;
  }

  it('lists people, not service accounts', async () => {
    const users = await listUsers(db());
    expect(users.map((u) => [u.uid, u.username, u.status])).toEqual([
      [0, 'root', 'active'],
      [1000, 'anna', 'active'],
      [1001, 'bruno', 'invited'],
    ]);
    expect(users[0]).not.toHaveProperty('passwordHash');
  });

  it('suspends a user, closing their sessions, and audits it', async () => {
    const session = await createSession(db(), 1000);
    expect(await getSession(db(), session.token)).not.toBeNull();

    expect(await suspendUser(db(), 0, 1000)).toEqual({ ok: true, status: 'suspended' });
    expect(await getSession(db(), session.token)).toBeNull();
    const [row] = await db().select().from(schema.sessions).where(eq(schema.sessions.uid, 1000));
    expect(row).toBeUndefined();
    expect(await lastAudit()).toMatchObject({
      actorUid: 0,
      action: 'user.suspend',
      outcome: 'ok',
      details: { uid: 1000, username: 'anna', previousStatus: 'active' },
    });
    expect(await suspendUser(db(), 0, 1000)).toEqual({ ok: false, reason: 'not_suspendable' });
  });

  it('refuses to suspend oneself, root, service accounts and unknown users', async () => {
    expect(await suspendUser(db(), 1001, 1001)).toEqual({ ok: false, reason: 'self' });
    expect(await suspendUser(db(), 1000, 0)).toEqual({ ok: false, reason: 'root' });
    expect(await suspendUser(db(), 0, 1)).toEqual({ ok: false, reason: 'not_found' });
    expect(await suspendUser(db(), 0, 4242)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reactivates to active, or to invited without a password', async () => {
    expect(await reactivateUser(db(), 0, 1000)).toEqual({ ok: true, status: 'active' });
    expect(await lastAudit()).toMatchObject({ action: 'user.reactivate' });
    expect(await reactivateUser(db(), 0, 1000)).toEqual({ ok: false, reason: 'not_suspended' });

    await suspendUser(db(), 0, 1001);
    expect(await reactivateUser(db(), 0, 1001)).toEqual({ ok: true, status: 'invited' });
  });
});
