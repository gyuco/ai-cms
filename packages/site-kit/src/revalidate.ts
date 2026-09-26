import { createHash, timingSafeEqual } from 'node:crypto';
import { readSecret } from '@ai-cms/db';
import { normalizePublicPath, pageNodeFromPath } from './paths.ts';

/** Revalidation endpoint of the site, reachable only on the internal network (TECHNICAL §9). */
export const REVALIDATE_PATH = '/__cms/revalidate';
/** In a revalidation request, every page, layout and setting. */
export const ALL_PATHS = '*';
const MAX_PATHS = 1000;

/** Shared token between cms-api and the site: `REVALIDATE_TOKEN` or the `revalidate_token` secret. */
export function revalidateToken(): string {
  return process.env.REVALIDATE_TOKEN ?? readSecret('revalidate_token');
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Checks `Authorization: Bearer <token>` in constant time. */
export function isAuthorized(header: string | null, token: string): boolean {
  if (!token) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  // Comparing fixed-size digests hides the token length too.
  return timingSafeEqual(digest(match?.[1] ?? ''), digest(token)) && match !== null;
}

export type RevalidateBody = { ok: true; paths: string[] } | { ok: false; error: string };

/** Validates `{ paths: string[] }`: public page paths such as `/chi-siamo`, or `'*'`. */
export function parseRevalidateBody(input: unknown): RevalidateBody {
  const paths = (input as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS) {
    return { ok: false, error: `"paths" deve essere una lista di 1–${MAX_PATHS} percorsi` };
  }
  const out = new Set<string>();
  for (const path of paths) {
    if (path === ALL_PATHS) {
      out.add(ALL_PATHS);
      continue;
    }
    if (typeof path !== 'string' || !pageNodeFromPath(path)) {
      return { ok: false, error: `Percorso non valido: ${JSON.stringify(path)}` };
    }
    out.add(normalizePublicPath(path));
  }
  return { ok: true, paths: [...out] };
}

export interface RevalidationResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Sends a revalidation request to a site; never throws. */
export async function requestRevalidation(options: {
  siteUrl: string;
  token: string;
  paths: string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<RevalidationResult> {
  try {
    const response = await (options.fetch ?? fetch)(
      `${options.siteUrl.replace(/\/+$/, '')}${REVALIDATE_PATH}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ paths: options.paths }),
        cache: 'no-store',
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      },
    );
    if (response.ok) return { ok: true, status: response.status };
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
