import { contentAgentProfile, devAgentProfile } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deleteExpiredAgentSessions,
  issueAgentSession,
  resolveAgentSession,
  revokeAgentSession,
} from './agent-sessions.ts';

describe.skipIf(!testDatabaseUrl)('agent sessions', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let uid: number;

  beforeAll(async () => {
    database = await createTestDatabase();
    const [row] = await database.db
      .insert(schema.users)
      .values({ username: 'bruno', email: 'bruno@example.com', status: 'active' })
      .returning();
    uid = row!.uid;
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('resolves a valid token to the user masked by the agent profile', async () => {
    const { token, expiresAt } = await issueAgentSession(database.db, {
      uid,
      agent: 'content-agent',
      env: 'prod',
      scope: ['site.pages.blog'],
      ttlMs: 60_000,
    });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const [stored] = await database.db.select().from(schema.agentSessions);
    expect(stored!.id).not.toBe(token);
    expect(stored!.id).toMatch(/^[0-9a-f]{64}$/);

    const session = await resolveAgentSession(database.db, token);
    expect(session).toMatchObject({ agent: 'content-agent', env: 'prod', conversationId: null });
    expect(session!.principal).toEqual({
      uid,
      username: 'bruno',
      status: 'active',
      agent: contentAgentProfile,
      scope: ['site.pages.blog'],
    });
  });

  it('uses the developer profile for dev-agent sessions', async () => {
    const { token } = await issueAgentSession(database.db, {
      uid,
      agent: 'dev-agent',
      env: 'staging',
      ttlMs: 60_000,
    });
    const session = await resolveAgentSession(database.db, token);
    expect(session!.principal.agent).toBe(devAgentProfile);
    expect(session!.principal.scope).toBeUndefined();
  });

  it('rejects expired, unknown and revoked tokens', async () => {
    const { token: expired } = await issueAgentSession(database.db, {
      uid,
      agent: 'content-agent',
      env: 'prod',
      ttlMs: -1000,
    });
    expect(await resolveAgentSession(database.db, expired)).toBeNull();
    expect(await resolveAgentSession(database.db, 'not-a-token')).toBeNull();
    expect(await resolveAgentSession(database.db, '')).toBeNull();

    const { token } = await issueAgentSession(database.db, {
      uid,
      agent: 'content-agent',
      env: 'prod',
      ttlMs: 60_000,
    });
    await revokeAgentSession(database.db, token);
    expect(await resolveAgentSession(database.db, token)).toBeNull();

    await deleteExpiredAgentSessions(database.db);
    const rows = await database.db.select().from(schema.agentSessions);
    expect(rows.every((r) => r.expiresAt.getTime() > Date.now())).toBe(true);
  });

  it('rejects tokens of users who are no longer active', async () => {
    const { token } = await issueAgentSession(database.db, {
      uid,
      agent: 'content-agent',
      env: 'prod',
      ttlMs: 60_000,
    });
    await database.db
      .update(schema.users)
      .set({ status: 'suspended' })
      .where(eq(schema.users.uid, uid));
    expect(await resolveAgentSession(database.db, token)).toBeNull();
    await database.db
      .update(schema.users)
      .set({ status: 'active' })
      .where(eq(schema.users.uid, uid));
  });
});
