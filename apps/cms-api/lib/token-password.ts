import { MIN_PASSWORD_LENGTH, sessionCookies, setPasswordWithToken } from '@ai-cms/auth';
import { db } from './db.ts';
import { cookieOptions, error, isSameOrigin, json, requestMeta } from './http.ts';

/** Shared handler for accepting an invite and confirming a password reset. */
export async function handleTokenPassword(request: Request, purpose: 'invite' | 'reset') {
  if (!isSameOrigin(request)) return error(403, 'origin', 'Origine della richiesta non valida.');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.token !== 'string' || typeof body.password !== 'string') {
    return error(400, 'bad_request', 'Richiesta non valida.');
  }
  const result = await setPasswordWithToken(
    db(),
    body.token,
    purpose,
    body.password,
    requestMeta(request),
  );
  if (!result.ok) {
    return result.reason === 'too_short'
      ? error(400, 'too_short', `La password deve avere almeno ${MIN_PASSWORD_LENGTH} caratteri.`)
      : error(400, 'invalid_token', 'Il link non è valido o è scaduto.');
  }
  return json(
    { csrfToken: result.csrfToken },
    { cookies: sessionCookies(result.token, result.expiresAt, cookieOptions) },
  );
}
