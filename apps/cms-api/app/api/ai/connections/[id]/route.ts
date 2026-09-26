import { deleteConnection, updateConnection, type UpdateConnectionInput } from '@ai-cms/ai-config';
import { aiErrorResponse, principalOf, readJson, secretOptions } from '@/lib/ai.ts';
import { authenticate } from '@/lib/context.ts';
import { db } from '@/lib/db.ts';
import { error, json } from '@/lib/http.ts';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, { params }: Params) {
  const context = await authenticate(request);
  if (context instanceof Response) return context;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return error(400, 'bad_request', 'Richiesta non valida.');
  try {
    const connection = await updateConnection(
      db(),
      principalOf(context),
      id,
      body as UpdateConnectionInput,
      secretOptions(),
    );
    return json({ connection });
  } catch (err) {
    return aiErrorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const context = await authenticate(request);
  if (context instanceof Response) return context;
  const { id } = await params;
  try {
    await deleteConnection(db(), principalOf(context), id);
    return json({ ok: true });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
