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

/** The page behind the current URL (`GET /_cms/api/context`, TECHNICAL §10.3). */
export interface NodeInfo {
  /** Public node path, e.g. `/site/pages/chi-siamo`; null when the URL cannot be a page. */
  path: string | null;
  kind: string | null;
  exists: boolean;
  version: number | null;
}

export interface PageStatus {
  latestVersion: number | null;
  publishedVersion: number | null;
  hasDraft: boolean;
}

export interface WidgetContext extends Me {
  /** Null while a password change is pending. */
  node: NodeInfo | null;
  page: PageStatus | null;
}

export const API_BASE = '/_cms/api';

type FetchFn = typeof fetch;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function failure(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string; code?: string };
  } | null;
  return new ApiError(
    response.status,
    body?.error?.message ?? 'Si è verificato un errore. Riprova tra poco.',
    body?.error?.code,
  );
}

/**
 * Removes the `cms_ui` hint cookie so the loader stops fetching the widget once the session
 * is gone. It is not HttpOnly on purpose (TECHNICAL §10.1).
 */
export function clearUiCookie(doc: Pick<Document, 'cookie'> = document): void {
  doc.cookie = `${UI_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
}

/**
 * The session and the page at `path` (the site URL path), or `null` when there is no valid
 * session (401).
 */
export async function fetchContext(
  path: string,
  fetchFn: FetchFn = fetch,
  doc: Pick<Document, 'cookie'> = document,
): Promise<WidgetContext | null> {
  const response = await fetchFn(`${API_BASE}/context?path=${encodeURIComponent(path)}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (response.status === 401) {
    clearUiCookie(doc);
    return null;
  }
  if (!response.ok) throw await failure(response);
  return (await response.json()) as WidgetContext;
}

export type Query = Record<string, string | number | null | undefined>;

/** JSON client for the CMS API; mutating calls carry the session's CSRF token. */
export interface Api {
  get<T>(path: string, query?: Query): Promise<T>;
  send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>;
}

export function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export function createApi(csrfToken: string, fetchFn: FetchFn = fetch): Api {
  const call = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await fetchFn(`${API_BASE}${path}`, { credentials: 'same-origin', ...init });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  };
  return {
    get: (path, query) => call(withQuery(path, query), { headers: { accept: 'application/json' } }),
    send: (method, path, body) =>
      call(path, {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
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
