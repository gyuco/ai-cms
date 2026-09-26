import { schema } from '@ai-cms/db';
import { and, desc, eq, gte, like, lt, sql, type SQL } from 'drizzle-orm';
import type { AuditOutcome, Executor } from './audit.ts';

export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['allowed', 'denied', 'ok', 'error'];
export const AUDIT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface AuditFilters {
  /** Username, or uid when numeric. */
  actor?: string;
  /** Action prefix: `content` matches `content.publish`, `content.write`, … */
  action?: string;
  /** Node path in ltree form; the entry's node must be this node or inside it. */
  path?: string;
  /** Inclusive lower bound. */
  from?: Date;
  /** Exclusive upper bound. */
  to?: Date;
  outcome?: AuditOutcome;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Pass as `cursor` to get the next (older) page; null on the last page. */
  nextCursor: number | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  actorUid: number;
  /** Username of the actor, null if the user no longer exists. */
  actor: string | null;
  agent: string | null;
  action: string;
  /** Public form of the node path, e.g. `/site/pages/blog`. */
  nodePath: string | null;
  env: string | null;
  outcome: string;
  details: unknown;
}

export type ParsedAuditQuery =
  | { ok: true; filters: AuditFilters; cursor: number | null; limit: number }
  | { ok: false; message: string };

const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string, endOfDay: boolean): Date | null {
  const date = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return null;
  // A day given as `to` includes the whole day.
  if (endOfDay && DATE_ONLY.test(value)) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

/**
 * Reads the filters of `GET /_cms/api/audit` from a query string, with Italian messages for
 * invalid values. Dates are `YYYY-MM-DD` (whole days, UTC) or ISO timestamps.
 */
export function parseAuditQuery(params: URLSearchParams): ParsedAuditQuery {
  const get = (key: string) => params.get(key)?.trim() || undefined;
  const filters: AuditFilters = {};

  const actor = get('actor');
  if (actor) filters.actor = actor;
  const action = get('action');
  if (action) filters.action = action;

  const path = get('path');
  if (path) {
    const ltree = path.replace(/^\/+|\/+$/g, '').replaceAll('/', '.');
    if (ltree !== '' && !ltree.split('.').every((segment) => SEGMENT.test(segment))) {
      return { ok: false, message: `Percorso non valido: "${path}".` };
    }
    if (ltree !== '') filters.path = ltree;
  }

  for (const key of ['from', 'to'] as const) {
    const value = get(key);
    if (!value) continue;
    const date = parseDate(value, key === 'to');
    if (!date) return { ok: false, message: `Data non valida: "${value}" (usa AAAA-MM-GG).` };
    filters[key] = date;
  }

  const outcome = get('outcome');
  if (outcome) {
    if (!(AUDIT_OUTCOMES as readonly string[]).includes(outcome)) {
      return { ok: false, message: `Esito sconosciuto: "${outcome}".` };
    }
    filters.outcome = outcome as AuditOutcome;
  }

  let cursor: number | null = null;
  const rawCursor = get('cursor');
  if (rawCursor) {
    cursor = Number(rawCursor);
    if (!Number.isSafeInteger(cursor) || cursor <= 0) {
      return { ok: false, message: 'Posizione nella lista non valida.' };
    }
  }

  let limit = AUDIT_PAGE_SIZE;
  const rawLimit = get('limit');
  if (rawLimit) {
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      return { ok: false, message: 'Numero di righe non valido.' };
    }
    limit = Math.min(limit, MAX_PAGE_SIZE);
  }
  return { ok: true, filters, cursor, limit };
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The audit log, newest first, one page at a time (by decreasing id). */
export async function queryAudit(
  db: Executor,
  filters: AuditFilters,
  options: { cursor?: number | null; limit?: number } = {},
): Promise<AuditPage> {
  const { auditLog, users } = schema;
  const limit = Math.min(Math.max(options.limit ?? AUDIT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const conditions: (SQL | undefined)[] = [];
  if (options.cursor) conditions.push(lt(auditLog.id, options.cursor));
  if (filters.actor) {
    conditions.push(
      /^\d+$/.test(filters.actor)
        ? eq(auditLog.actorUid, Number(filters.actor))
        : sql`${users.username} = ${filters.actor}`,
    );
  }
  if (filters.action) conditions.push(like(auditLog.action, `${escapeLike(filters.action)}%`));
  if (filters.path) conditions.push(sql`${auditLog.nodePath} <@ ${filters.path}::ltree`);
  if (filters.from) conditions.push(gte(auditLog.at, filters.from.toISOString()));
  if (filters.to) conditions.push(lt(auditLog.at, filters.to.toISOString()));
  if (filters.outcome) conditions.push(eq(auditLog.outcome, filters.outcome));

  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actorUid: auditLog.actorUid,
      actor: users.username,
      agent: auditLog.agent,
      action: auditLog.action,
      nodePath: auditLog.nodePath,
      env: auditLog.env,
      outcome: auditLog.outcome,
      details: auditLog.details,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.uid, auditLog.actorUid))
    .where(and(...conditions))
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    entries: page.map((row) => ({
      ...row,
      at: new Date(row.at).toISOString(),
      nodePath: row.nodePath === null ? null : `/${row.nodePath.replaceAll('.', '/')}`,
    })),
    nextCursor: rows.length > limit ? page.at(-1)!.id : null,
  };
}
