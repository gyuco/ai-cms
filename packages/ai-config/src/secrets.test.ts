import { AuthzError, contentAgentProfile, type Principal } from '@ai-cms/authz';
import { schema } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteSecret, getSecretHint, readSecretValue, setSecret } from './secrets.ts';

const masterKey = 'test-master-key-0123456789';
const apiKey = 'sk-ant-api03-supersecret-a1b2';

describe.skipIf(!testDatabaseUrl)('secrets', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let user: Principal;

  beforeAll(async () => {
    database = await createTestDatabase();
    const [row] = await database.db
      .insert(schema.users)
      .values({ username: 'anna', email: 'anna@example.com', status: 'active' })
      .returning();
    user = { uid: row!.uid, username: 'anna', status: 'active' };
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('stores only ciphertext and a hint, and decrypts for the gateway', async () => {
    const { hint } = await setSecret(database.db, user, 'ai/anthropic', apiKey, { masterKey });
    expect(hint).toBe('…a1b2');
    const [row] = await database.db
      .select()
      .from(schema.secrets)
      .where(eq(schema.secrets.name, 'ai/anthropic'));
    expect(row!.ciphertext).not.toContain('supersecret');
    expect(row!.keyVersion).toBe(1);
    expect(row!.createdBy).toBe(user.uid);
    expect(await readSecretValue(database.db, 'ai/anthropic', { masterKey })).toBe(apiKey);
    expect(await getSecretHint(database.db, user, 'ai/anthropic')).toBe('…a1b2');
    expect(await readSecretValue(database.db, 'ai/missing', { masterKey })).toBeNull();
  });

  it('replaces an existing secret', async () => {
    await setSecret(database.db, user, 'ai/anthropic', 'sk-ant-api03-replaced-zzzz', { masterKey });
    expect(await readSecretValue(database.db, 'ai/anthropic', { masterKey })).toBe(
      'sk-ant-api03-replaced-zzzz',
    );
  });

  it('never writes the value into the audit log', async () => {
    const rows = await database.db
      .select()
      .from(schema.auditLog)
      .where(like(schema.auditLog.action, 'secret.%'));
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('supersecret');
    expect(dump).not.toContain('replaced');
    expect(rows[0]!.nodePath).toBe('system.secrets.ai.anthropic');
  });

  it('refuses agents (invariant I4) and audits the denial', async () => {
    const agent: Principal = { ...user, agent: contentAgentProfile };
    const attempt = setSecret(database.db, agent, 'ai/evil', 'sk-evil-value-123456', { masterKey });
    await expect(attempt).rejects.toBeInstanceOf(AuthzError);
    await expect(attempt).rejects.toMatchObject({ code: 'invariant-I4' });
    await expect(getSecretHint(database.db, agent, 'ai/anthropic')).rejects.toMatchObject({
      code: 'invariant-I4',
    });
    const denied = await database.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.outcome, 'denied'));
    expect(denied.map((r) => r.agent)).toContain('content-agent');
    expect(JSON.stringify(denied)).not.toContain('sk-evil');
    const [row] = await database.db
      .select()
      .from(schema.secrets)
      .where(eq(schema.secrets.name, 'ai/evil'));
    expect(row).toBeUndefined();
  });

  it('refuses invalid names and deletes secrets', async () => {
    await expect(
      setSecret(database.db, user, '../x', 'value-value-value', { masterKey }),
    ).rejects.toMatchObject({
      code: 'invalid_secret_name',
    });
    expect(await deleteSecret(database.db, user, 'ai/anthropic')).toBe(true);
    expect(await deleteSecret(database.db, user, 'ai/anthropic')).toBe(false);
    expect(await getSecretHint(database.db, user, 'ai/anthropic')).toBeNull();
  });
});
