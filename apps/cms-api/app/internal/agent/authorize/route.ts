import { handleAgentAuthorize } from '@ai-cms/ai-config';
import { db } from '@/lib/db.ts';

// Internal only: the developer agent's PreToolUse hook and native tools ask here whether a
// file or command is allowed (TECHNICAL §7.6). Caddy answers 404 on public hosts.
export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  // Defense in depth: Caddy sets X-CMS-Env on every request it proxies from a public host.
  if (request.headers.has('x-cms-env')) return new Response('Not found', { status: 404 });
  return handleAgentAuthorize(request, { db: db() });
}
