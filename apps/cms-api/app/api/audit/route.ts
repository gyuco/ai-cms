import { parseAuditQuery, queryAudit } from '@ai-cms/audit';
import { db } from '@/lib/db.ts';
import { BadRequestError } from '@/lib/errors.ts';
import { json } from '@/lib/http.ts';
import { route } from '@/lib/route.ts';

export const dynamic = 'force-dynamic';

/**
 * Audit tab (E7.12): `?actor=&action=&path=&from=&to=&outcome=&cursor=&limit=`, newest first.
 * Phase 1: every user is an administrator; later this needs CAP_AUDIT_READ.
 */
export const GET = route(async (request) => {
  const query = parseAuditQuery(new URL(request.url).searchParams);
  if (!query.ok) throw new BadRequestError(query.message);
  return json(await queryAudit(db(), query.filters, query));
});
