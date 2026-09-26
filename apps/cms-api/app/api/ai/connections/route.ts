import {
  createConnection,
  listConnections,
  listRoleAssignments,
  withSubscriptionStatus,
  type CreateConnectionInput,
} from '@ai-cms/ai-config';
import { subscriptionLinked } from '@/lib/agent-runner.ts';
import { aiErrorResponse, principalOf, readJson, secretOptions } from '@/lib/ai.ts';
import { authenticate } from '@/lib/context.ts';
import { db } from '@/lib/db.ts';
import { error, json } from '@/lib/http.ts';

export const dynamic = 'force-dynamic';

// Responses never contain API keys, only their hint (FR-127).
export async function GET(request: Request) {
  const context = await authenticate(request);
  if (context instanceof Response) return context;
  const principal = principalOf(context);
  try {
    const [connections, roles, linked] = await Promise.all([
      listConnections(db(), principal),
      listRoleAssignments(db(), principal),
      // Only the agent-runner can read the subscription profiles: the answer may be unknown.
      subscriptionLinked(principal, context.env),
    ]);
    return json({ connections: withSubscriptionStatus(connections, linked), roles });
  } catch (err) {
    return aiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  const context = await authenticate(request);
  if (context instanceof Response) return context;
  const body = await readJson(request);
  if (!body) return error(400, 'bad_request', 'Richiesta non valida.');
  try {
    const connection = await createConnection(
      db(),
      principalOf(context),
      body as CreateConnectionInput,
      secretOptions(),
    );
    return json({ connection }, { status: 201 });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
