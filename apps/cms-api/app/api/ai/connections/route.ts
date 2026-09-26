import {
  createConnection,
  listConnections,
  listRoleAssignments,
  type CreateConnectionInput,
} from '@ai-cms/ai-config';
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
    const [connections, roles] = await Promise.all([
      listConnections(db(), principal),
      listRoleAssignments(db(), principal),
    ]);
    return json({ connections, roles });
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
