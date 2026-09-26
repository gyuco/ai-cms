import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Read at request time: the bundle is built separately and must not be baked in at build.
export const dynamic = 'force-dynamic';

function bundlePath(): string {
  return (
    process.env.WIDGET_BUNDLE ?? path.resolve(process.cwd(), '../../packages/widget/dist/widget.js')
  );
}

/** Serves the widget bundle at /_cms/widget.js (TECHNICAL §10.1). */
export async function GET() {
  let source: Buffer;
  try {
    // Not traced into the standalone output: the Docker image copies the bundle itself.
    source = await readFile(/* turbopackIgnore: true */ bundlePath());
  } catch {
    return new Response('// widget bundle not built\n', {
      status: 404,
      headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return new Response(new Uint8Array(source), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'x-content-type-options': 'nosniff',
    },
  });
}
