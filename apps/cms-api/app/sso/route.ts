import { sessionCookies, signOnWithToken } from '@ai-cms/auth';
import { db } from '@/lib/db.ts';
import { cookieOptions, requestEnv, requestMeta, safeReturnTo } from '@/lib/http.ts';
import { siteUrl } from '@/lib/sites.ts';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = siteUrl(requestEnv(request));
  const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
  const session = await signOnWithToken(
    db(),
    url.searchParams.get('t') ?? '',
    requestMeta(request),
  );
  const headers = new Headers({ 'cache-control': 'no-store' });
  if (!session) {
    headers.set('location', `${base}/_cms/login?returnTo=${encodeURIComponent(returnTo)}`);
    return new Response(null, { status: 303, headers });
  }
  for (const cookie of sessionCookies(session.token, session.expiresAt, cookieOptions)) {
    headers.append('set-cookie', cookie);
  }
  headers.set('location', `${base}${returnTo}`);
  return new Response(null, { status: 303, headers });
}
