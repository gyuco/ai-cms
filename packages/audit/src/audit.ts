import { createHash } from 'node:crypto';
import { schema, type Database } from '@ai-cms/db';
import { asc, desc, sql } from 'drizzle-orm';
import { canonicalJson } from './canonical.ts';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;

export const GENESIS_HASH = '0'.repeat(64);

// Serializes writers so the chain never forks (pg_advisory_xact_lock key).
const AUDIT_LOCK_KEY = 7_411_001;

export type AuditOutcome = 'allowed' | 'denied' | 'ok' | 'error';

export interface AuditEvent {
  actorUid: number;
  agent?: string | null;
  action: string;
  /** Node path in ltree form (`site.pages.blog`), if the event concerns a node. */
  nodePath?: string | null;
  env?: 'prod' | 'staging' | null;
  outcome: AuditOutcome;
  details?: Record<string, unknown> | null;
}

interface HashedFields {
  at: string;
  actorUid: number;
  agent: string | null;
  action: string;
  nodePath: string | null;
  env: string | null;
  outcome: string;
  details: unknown;
}

export function hashEntry(prevHash: string, fields: HashedFields): string {
  return createHash('sha256').update(prevHash).update(canonicalJson(fields)).digest('hex');
}

/**
 * Appends an event to the audit log. Runs in its own transaction (a savepoint when given a
 * transaction), so an audited action and its audit row commit or roll back together.
 */
export async function writeAudit(executor: Executor, event: AuditEvent) {
  return executor.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`);
    const [last] = await tx
      .select({ hash: schema.auditLog.hash })
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.id))
      .limit(1);
    const prevHash = last?.hash ?? GENESIS_HASH;
    const fields: HashedFields = {
      at: new Date().toISOString(),
      actorUid: event.actorUid,
      agent: event.agent ?? null,
      action: event.action,
      nodePath: event.nodePath ?? null,
      env: event.env ?? null,
      outcome: event.outcome,
      details: event.details ?? null,
    };
    const [row] = await tx
      .insert(schema.auditLog)
      .values({ ...fields, prevHash, hash: hashEntry(prevHash, fields) })
      .returning();
    return row!;
  });
}

export type ChainCheck = { ok: true; entries: number } | { ok: false; brokenAt: number };

/** Recomputes the whole chain; returns the first row id whose hash does not match. */
export async function verifyAuditChain(executor: Executor): Promise<ChainCheck> {
  const rows = await executor.select().from(schema.auditLog).orderBy(asc(schema.auditLog.id));
  let prevHash = GENESIS_HASH;
  for (const row of rows) {
    const expected = hashEntry(prevHash, {
      at: new Date(row.at).toISOString(),
      actorUid: row.actorUid,
      agent: row.agent,
      action: row.action,
      nodePath: row.nodePath,
      env: row.env,
      outcome: row.outcome,
      details: row.details,
    });
    if (row.prevHash !== prevHash || row.hash !== expected) return { ok: false, brokenAt: row.id };
    prevHash = row.hash;
  }
  return { ok: true, entries: rows.length };
}
