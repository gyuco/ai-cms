import { getSession, safeEqual, SESSION_COOKIE, type ActiveSession } from '@ai-cms/auth';
import { db } from './db.ts';
import { error, isSameOrigin, readCookie, requestEnv, requestMeta, type Env } from './http.ts';

export interface RequestContext {
  session: ActiveSession;
  token: string;
  env: Env;
  meta: ReturnType<typeof requestMeta>;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Resolves the authenticated context of a request (E3.3). Mutating requests must also be
 * same-origin and carry the session's CSRF token in the `x-csrf-token` header.
 */
export async function authenticate(
  request: Request,
  options: { allowPasswordChangePending?: boolean } = {},
): Promise<RequestContext | Response> {
  const token = readCookie(request, SESSION_COOKIE);
  const session = token ? await getSession(db(), token) : null;
  if (!token || !session) return error(401, 'unauthenticated', 'Accesso richiesto.');

  if (MUTATING.has(request.method)) {
    const csrf = request.headers.get('x-csrf-token') ?? '';
    if (!isSameOrigin(request) || !safeEqual(csrf, session.csrfToken)) {
      return error(403, 'csrf', 'Richiesta non valida: ricarica la pagina e riprova.');
    }
  }

  if (session.user.mustChangePassword && !options.allowPasswordChangePending) {
    return error(403, 'password_change_required', 'Devi cambiare la password prima di continuare.');
  }

  return { session, token, env: requestEnv(request), meta: requestMeta(request) };
}
