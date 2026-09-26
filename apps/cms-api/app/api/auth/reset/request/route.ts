import { requestPasswordReset } from '@ai-cms/auth';
import { db } from '@/lib/db.ts';
import { error, isSameOrigin, json, requestEnv } from '@/lib/http.ts';
import { mail } from '@/lib/mail.ts';
import { siteUrl } from '@/lib/sites.ts';

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return error(403, 'origin', 'Origine della richiesta non valida.');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.email !== 'string') return error(400, 'bad_request', 'Indica la tua email.');
  await requestPasswordReset(db(), mail(), body.email, siteUrl(requestEnv(request)));
  // Same answer whether or not the address exists.
  return json({ ok: true });
}
