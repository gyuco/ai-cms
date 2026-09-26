import { handleAgentWhoami } from '@ai-cms/ai-config';
import { db } from '@/lib/db.ts';

// Internal only: the agent-runner, which has no database, resolves its agent session token
// here (http://cms-api:3100/_cms/internal/agent/whoami). Caddy answers 404 on public hosts.
export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  // Defense in depth: Caddy sets X-CMS-Env on every request it proxies from a public host.
  if (request.headers.has('x-cms-env')) return new Response('Not found', { status: 404 });
  return handleAgentWhoami(request, { db: db() });
}
