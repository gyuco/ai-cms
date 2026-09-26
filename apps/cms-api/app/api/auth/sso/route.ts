import { issueAuthToken } from '@ai-cms/auth';
import { authenticate } from '@/lib/context.ts';
import { db } from '@/lib/db.ts';
import { error, json, safeReturnTo } from '@/lib/http.ts';
import { siteUrl } from '@/lib/sites.ts';

/** Returns a one-minute link that signs the user in on the other environment (E3.5). */
export async function POST(request: Request) {
  const context = await authenticate(request);
  if (context instanceof Response) return context;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const target = body?.target;
  if (target !== 'prod' && target !== 'staging') {
    return error(400, 'bad_request', 'Ambiente di destinazione non valido.');
  }
  const token = await issueAuthToken(db(), context.session.user.uid, 'sso');
  const returnTo = safeReturnTo(body?.returnTo);
  const url = `${siteUrl(target)}/_cms/sso?t=${token}&returnTo=${encodeURIComponent(returnTo)}`;
  return json({ url });
}
