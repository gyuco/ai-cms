import { Readable } from 'node:stream';
import { openPublishedAsset } from '@ai-cms/content/assets';
import { assetStorage } from '@/lib/assets.ts';
import { db } from '@/lib/db.ts';
import { error, requestEnv } from '@/lib/http.ts';

export const dynamic = 'force-dynamic';

/** Public asset files: /_cms/assets/<id> and /_cms/assets/<id>/<variant>. Published only. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; variant?: string[] }> },
) {
  const { id, variant } = await params;
  const file = await openPublishedAsset(
    db(),
    await assetStorage(),
    requestEnv(request),
    id,
    variant?.[0],
  );
  if (!file) return error(404, 'not_found', 'File non trovato.');
  const headers = new Headers({
    'content-type': file.contentType,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  if (file.contentLength !== undefined) headers.set('content-length', String(file.contentLength));
  return new Response(Readable.toWeb(file.stream) as ReadableStream, { headers });
}
