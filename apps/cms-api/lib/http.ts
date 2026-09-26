import type { SessionMeta } from '@ai-cms/auth';

export type Env = 'prod' | 'staging';

export const cookieOptions = { secure: process.env.COOKIE_SECURE !== '0' };

/** Set by Caddy for each site host; the client can never choose it (TECHNICAL §10.1). */
export function requestEnv(request: Request): Env {
  return request.headers.get('x-cms-env') === 'staging' ? 'staging' : 'prod';
}

export function requestMeta(request: Request): SessionMeta {
  const forwarded = request.headers.get('x-forwarded-for');
  return {
    ip: forwarded?.split(',')[0]?.trim() || null,
    userAgent: request.headers.get('user-agent'),
  };
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Mutating requests must come from a page on the same origin. Browsers always send Origin
 * on cross-site POSTs, so a missing or different Origin is rejected.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Only same-site relative paths are allowed as redirect targets after login. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\')) return '/';
  return value;
}

export function json(body: unknown, init: ResponseInit & { cookies?: string[] } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-store');
  for (const cookie of init.cookies ?? []) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status });
}
