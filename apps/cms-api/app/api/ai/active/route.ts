import { setActiveConnection } from '@ai-cms/ai-config';
import { aiErrorResponse, principalOf, readJson } from '@/lib/ai.ts';
import { authenticate } from '@/lib/context.ts';
import { db } from '@/lib/db.ts';
import { error, json } from '@/lib/http.ts';

export const dynamic = 'force-dynamic';

/** Phase 1: one connection for every AI role (TECHNICAL §7.8). Body: `{ connectionId, model? }`. */
export async function POST(request: Request) {
  const context = await authenticate(request);
  if (context instanceof Response) return context;
  const body = await readJson(request);
  if (typeof body?.connectionId !== 'string') {
    return error(400, 'bad_request', 'Indica la connessione da attivare.');
  }
  const model = typeof body.model === 'string' ? body.model : null;
  try {
    return json(await setActiveConnection(db(), principalOf(context), body.connectionId, model));
  } catch (err) {
    return aiErrorResponse(err);
  }
}
