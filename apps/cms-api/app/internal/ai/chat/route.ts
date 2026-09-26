import { handleInternalChat } from '@ai-cms/ai-config';
import { gateway } from '@/lib/ai.ts';
import { db } from '@/lib/db.ts';

// Internal only: Caddy answers 404 to /_cms/internal/* on every public host; the
// agent-runner calls http://cms-api:3100/_cms/internal/ai/chat on the internal network.
export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  // Defense in depth: Caddy sets X-CMS-Env on every request it proxies from a public host.
  if (request.headers.has('x-cms-env')) return new Response('Not found', { status: 404 });
  return handleInternalChat(request, { db: db(), gateway: gateway() });
}
