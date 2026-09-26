import { cmsApiUrl, SESSION_COOKIE, type SiteEnv } from './config.ts';

export type DraftResult =
  | { status: 'ok'; body: unknown; version: number; published: boolean }
  /** The page has no version at all in this environment. */
  | { status: 'not-found' }
  /** No valid session, or no read permission: the visitor sees the published site. */
  | { status: 'denied' }
  | { status: 'error'; message: string };

export interface DraftRequest {
  publicPath: string;
  env: SiteEnv;
  sessionToken: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Latest version of a page, published or not, for a signed-in user (FR-150). The site role
 * cannot read `content_versions`, so cms-api checks the session and the permissions and
 * returns the draft. Never cache the result: it depends on who is asking.
 */
export async function fetchDraft(request: DraftRequest): Promise<DraftResult> {
  const url = new URL(`${request.baseUrl ?? cmsApiUrl()}/_cms/api/preview`);
  url.searchParams.set('path', request.publicPath);
  url.searchParams.set('env', request.env);
  let response: Response;
  try {
    response = await (request.fetch ?? fetch)(url, {
      headers: {
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(request.sessionToken)}`,
        'x-cms-env': request.env,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(request.timeoutMs ?? 5000),
    });
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 401 || response.status === 403) return { status: 'denied' };
  if (response.status === 404) return { status: 'not-found' };
  if (!response.ok) return { status: 'error', message: `cms-api: HTTP ${response.status}` };
  try {
    const data = (await response.json()) as {
      body?: unknown;
      version?: unknown;
      published?: unknown;
    };
    if (data.body === undefined || typeof data.version !== 'number') {
      return { status: 'error', message: 'cms-api: risposta non valida' };
    }
    return {
      status: 'ok',
      body: data.body,
      version: data.version,
      published: data.published === true,
    };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}
