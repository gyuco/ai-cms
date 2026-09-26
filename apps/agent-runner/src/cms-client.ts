/**
 * Client for the internal cms-api endpoints the runner relies on. The runner has no database
 * and no API keys (TECHNICAL §3.1): who a token belongs to, whether a tool use is allowed and
 * every model call all go through cms-api.
 */

/** Mirrors `AgentWhoami` of `@ai-cms/ai-config` (not imported: it would pull in the DB layer). */
export interface AgentWhoami {
  uid: number;
  username: string;
  email: string;
  agent: 'content-agent' | 'dev-agent';
  env: 'prod' | 'staging';
  changesetId: string | null;
  conversationId: string | null;
  expiresAt: string;
}

export interface ToolUse {
  tool: string;
  /** Relative to the changeset clone. */
  path?: string;
  command?: string;
  exists?: boolean;
}

export interface ToolDecision {
  allowed: boolean;
  code: string;
  message: string;
}

export interface CmsClient {
  readonly baseUrl: string;
  whoami(token: string): Promise<AgentWhoami | null>;
  authorize(token: string, use: ToolUse): Promise<ToolDecision>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class CmsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CmsApiError';
  }
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `cms-api ha risposto ${res.status}`;
}

export function createCmsClient(options: { baseUrl: string; fetch?: FetchLike }): CmsClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return doFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(20_000),
    });
  }

  return {
    baseUrl,
    async whoami(token) {
      const res = await post('/_cms/internal/agent/whoami', { token });
      if (res.status === 401) return null;
      if (!res.ok) throw new CmsApiError(await errorMessage(res), res.status);
      return (await res.json()) as AgentWhoami;
    },
    async authorize(token, use) {
      const res = await post('/_cms/internal/agent/authorize', { token, ...use });
      if (!res.ok) throw new CmsApiError(await errorMessage(res), res.status);
      return (await res.json()) as ToolDecision;
    },
  };
}
