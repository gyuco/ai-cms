import { changePassword, MIN_PASSWORD_LENGTH, sessionCookies } from '@ai-cms/auth';
import { authenticate } from '@/lib/context.ts';
import { db } from '@/lib/db.ts';
import { cookieOptions, error, json } from '@/lib/http.ts';

const messages = {
  invalid_current: 'La password attuale non è corretta.',
  too_short: `La nuova password deve avere almeno ${MIN_PASSWORD_LENGTH} caratteri.`,
  unchanged: 'La nuova password deve essere diversa da quella attuale.',
} as const;

export async function POST(request: Request) {
  const context = await authenticate(request, { allowPasswordChangePending: true });
  if (context instanceof Response) return context;
  const body = (await request.json().catch(() => null)) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  } | null;
  if (typeof body?.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
    return error(400, 'bad_request', 'Compila tutti i campi.');
  }
  const result = await changePassword(
    db(),
    context.session.user.uid,
    body.currentPassword,
    body.newPassword,
    context.meta,
  );
  if (!result.ok) return error(400, result.reason, messages[result.reason]);
  return json(
    { csrfToken: result.csrfToken },
    { cookies: sessionCookies(result.token, result.expiresAt, cookieOptions) },
  );
}
