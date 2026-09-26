import { testConnection } from '@ai-cms/ai-config';
import { aiErrorResponse, gateway, principalOf, readJson } from '@/lib/ai.ts';
import { authenticate } from '@/lib/context.ts';
import { db } from '@/lib/db.ts';
import { json } from '@/lib/http.ts';

export const dynamic = 'force-dynamic';

/** "Prova connessione" (FR-123). Body: `{ model? }`, defaults to the connection's model. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await authenticate(request);
  if (context instanceof Response) return context;
  const { id } = await params;
  const body = await readJson(request);
  const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : null;
  try {
    return json(await testConnection(db(), principalOf(context), gateway(), id, model));
  } catch (err) {
    return aiErrorResponse(err);
  }
}
