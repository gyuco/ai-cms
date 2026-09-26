import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENESIS_HASH, verifyAuditChain, writeAudit } from './audit.ts';

describe.skipIf(!testDatabaseUrl)('audit log', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('chains entries and verifies the chain', async () => {
    const first = await writeAudit(database.db, {
      actorUid: 0,
      action: 'auth.login',
      outcome: 'ok',
      details: { ip: '127.0.0.1' },
    });
    expect(first.prevHash).toBe(GENESIS_HASH);
    const second = await writeAudit(database.db, {
      actorUid: 0,
      agent: 'content-agent',
      action: 'node.write',
      nodePath: 'site.pages.index',
      env: 'prod',
      outcome: 'allowed',
    });
    expect(second.prevHash).toBe(first.hash);
    expect(await verifyAuditChain(database.db)).toEqual({ ok: true, entries: 2 });
  });

  it('keeps the chain linear under concurrent writers', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        writeAudit(database.db, { actorUid: i, action: 'test.concurrent', outcome: 'ok' }),
      ),
    );
    expect(await verifyAuditChain(database.db)).toEqual({ ok: true, entries: 12 });
  });

  it('rolls back with the surrounding transaction', async () => {
    await expect(
      database.db.transaction(async (tx) => {
        await writeAudit(tx, { actorUid: 0, action: 'test.rollback', outcome: 'ok' });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await verifyAuditChain(database.db)).toEqual({ ok: true, entries: 12 });
  });

  it('blocks UPDATE and DELETE, even for the table owner', async () => {
    await expect(database.sql`UPDATE audit_log SET outcome = 'denied'`).rejects.toThrow(
      /append-only/,
    );
    await expect(database.sql`DELETE FROM audit_log`).rejects.toThrow(/append-only/);
    await expect(database.sql`TRUNCATE audit_log`).rejects.toThrow(/append-only/);
  });

  it('lets the runtime role insert and read but not modify', async () => {
    await database.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE cms_rw`;
      await tx`SELECT count(*) FROM audit_log`;
    });
    await expect(
      database.sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE cms_rw`;
        await tx`DELETE FROM audit_log`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('detects tampering done by bypassing the triggers', async () => {
    await database.sql.begin(async (tx) => {
      await tx`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete`;
      await tx`UPDATE audit_log SET outcome = 'denied' WHERE id = 2`;
      await tx`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete`;
    });
    expect(await verifyAuditChain(database.db)).toEqual({ ok: false, brokenAt: 2 });
  });
});
