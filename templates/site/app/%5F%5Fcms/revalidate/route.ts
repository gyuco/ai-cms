import {
  ALL_PATHS,
  invalidatePageIndex,
  isAuthorized,
  parseRevalidateBody,
  revalidateToken,
} from '@ai-cms/site-kit/data';
import { revalidatePath, revalidateTag } from 'next/cache';
import { CONTENT_TAG, PAGES_TAG, pathTag } from '@ai-cms/site-kit/next';

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * `POST /__cms/revalidate` (TECHNICAL §9): called by cms-api after a publication with
 * `{ paths: ['/chi-siamo'] }`, or `['*']` for changes shared by every page (layouts,
 * settings). Internal network only: Caddy answers 404 on `/__cms/*` from outside.
 */
export async function POST(request: Request) {
  let token: string;
  try {
    token = revalidateToken();
  } catch {
    return json({ error: 'Token di revalidazione non configurato.' }, 503);
  }
  if (!isAuthorized(request.headers.get('authorization'), token)) {
    return json({ error: 'Non autorizzato.' }, 401);
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'Il corpo della richiesta deve essere JSON.' }, 400);
  }
  const parsed = parseRevalidateBody(input);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  // Expire immediately: the next request reads the new content.
  const now = { expire: 0 };
  if (parsed.paths.includes(ALL_PATHS)) {
    revalidateTag(CONTENT_TAG, now);
    revalidatePath('/', 'layout');
  } else {
    for (const path of parsed.paths) {
      revalidateTag(pathTag(path), now);
      revalidatePath(path);
    }
    // A publication can add or remove a page: the sitemap and the page index change too.
    revalidateTag(PAGES_TAG, now);
  }
  invalidatePageIndex();
  return json({ revalidated: parsed.paths });
}
