/** Same name as `UI_COOKIE` in @ai-cms/auth; the widget does not depend on server packages. */
const UI_COOKIE_NAME = 'cms_ui';

export type Env = 'prod' | 'staging';

export interface Me {
  user: {
    uid: number;
    username: string;
    displayName: string | null;
    email: string;
    mustChangePassword: boolean;
  };
  env: Env;
  csrfToken: string;
}

export const API_BASE = '/_cms/api';

type FetchFn = typeof fetch;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function failure(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return new ApiError(
    response.status,
    body?.error?.message ?? 'Si è verificato un errore. Riprova tra poco.',
  );
}

/**
 * Removes the `cms_ui` hint cookie so the loader stops fetching the widget once the session
 * is gone. It is not HttpOnly on purpose (TECHNICAL §10.1).
 */
export function clearUiCookie(doc: Pick<Document, 'cookie'> = document): void {
  doc.cookie = `${UI_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
}

/** The signed-in user, or `null` when there is no valid session (401). */
export async function fetchMe(
  fetchFn: FetchFn = fetch,
  doc: Pick<Document, 'cookie'> = document,
): Promise<Me | null> {
  const response = await fetchFn(`${API_BASE}/auth/me`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (response.status === 401) {
    clearUiCookie(doc);
    return null;
  }
  if (!response.ok) throw await failure(response);
  return (await response.json()) as Me;
}

function post(fetchFn: FetchFn, path: string, csrfToken: string, body: unknown = {}) {
  return fetchFn(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body),
  });
}

export function otherEnv(env: Env): Env {
  return env === 'prod' ? 'staging' : 'prod';
}

/** Returns the one-time sign-on URL for the same page on the other environment (E3.5). */
export async function requestEnvSwitch(
  me: Me,
  returnTo: string,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const response = await post(fetchFn, '/auth/sso', me.csrfToken, {
    target: otherEnv(me.env),
    returnTo,
  });
  if (!response.ok) throw await failure(response);
  const { url } = (await response.json()) as { url: string };
  return url;
}

export async function logout(me: Me, fetchFn: FetchFn = fetch): Promise<void> {
  const response = await post(fetchFn, '/auth/logout', me.csrfToken);
  // An expired session is already logged out.
  if (!response.ok && response.status !== 401) throw await failure(response);
}
