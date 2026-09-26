import { login, sessionCookies } from '@ai-cms/auth';
import { db } from '@/lib/db.ts';
import { cookieOptions, error, isSameOrigin, json, requestMeta } from '@/lib/http.ts';

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return error(403, 'origin', 'Origine della richiesta non valida.');
  const body = (await request.json().catch(() => null)) as {
    identifier?: unknown;
    password?: unknown;
  } | null;
  if (typeof body?.identifier !== 'string' || typeof body.password !== 'string') {
    return error(400, 'bad_request', 'Inserisci nome utente e password.');
  }

  const result = await login(db(), body.identifier.trim(), body.password, requestMeta(request));
  if (!result.ok) {
    return result.reason === 'locked'
      ? error(429, 'locked', 'Troppi tentativi falliti. Riprova tra qualche minuto.')
      : error(401, 'invalid_credentials', 'Nome utente o password non corretti.');
  }
  return json(
    { mustChangePassword: result.mustChangePassword, csrfToken: result.csrfToken },
    { cookies: sessionCookies(result.token, result.expiresAt, cookieOptions) },
  );
}
