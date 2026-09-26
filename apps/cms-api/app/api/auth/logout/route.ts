import { clearedSessionCookies, destroySession } from '@ai-cms/auth';
import { writeAudit } from '@ai-cms/audit';
import { authenticate } from '@/lib/context.ts';
import { db } from '@/lib/db.ts';
import { cookieOptions, json } from '@/lib/http.ts';

export async function POST(request: Request) {
  const context = await authenticate(request, { allowPasswordChangePending: true });
  if (context instanceof Response) return context;
  await destroySession(db(), context.token);
  await writeAudit(db(), {
    actorUid: context.session.user.uid,
    action: 'auth.logout',
    outcome: 'ok',
  });
  return json({ ok: true }, { cookies: clearedSessionCookies(cookieOptions) });
}
