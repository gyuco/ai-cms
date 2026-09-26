import { suspendUser } from '@ai-cms/auth';
import { db } from '@/lib/db.ts';
import { route } from '@/lib/route.ts';
import { parseUid, statusChangeResponse } from '@/lib/users.ts';

export const dynamic = 'force-dynamic';

/** Suspends a user and closes their sessions (FR-70). */
export const POST = route<{ uid: string }>(async (_request, context, params) =>
  statusChangeResponse(await suspendUser(db(), context.session.user.uid, parseUid(params.uid))),
);
