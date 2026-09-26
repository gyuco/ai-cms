import { inviteUser } from '@ai-cms/auth';
import { authenticate } from '@/lib/context.ts';
import { db } from '@/lib/db.ts';
import { error, json } from '@/lib/http.ts';
import { mail } from '@/lib/mail.ts';
import { siteUrl } from '@/lib/sites.ts';

const messages = {
  invalid_username: 'Nome utente non valido: 2-32 caratteri tra lettere, numeri, punto, trattino.',
  invalid_email: 'Indirizzo email non valido.',
  exists: 'Esiste già un utente con questo nome o questa email.',
} as const;

// Phase 1: every authenticated user is an administrator (MVP1.md, E4).
export async function POST(request: Request) {
  const context = await authenticate(request);
  if (context instanceof Response) return context;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.username !== 'string' || typeof body.email !== 'string') {
    return error(400, 'bad_request', 'Indica nome utente ed email.');
  }
  const result = await inviteUser(
    db(),
    mail(),
    context.session.user.uid,
    {
      username: body.username,
      email: body.email,
      displayName: typeof body.displayName === 'string' ? body.displayName : null,
    },
    siteUrl('prod'),
  );
  if (!result.ok) return error(400, result.reason, messages[result.reason]);
  return json({ uid: result.uid }, { status: 201 });
}
