import { SESSION_COOKIE, normalizePublicPath, pageNodeFromPath } from '@ai-cms/site-kit/data';
import { NextResponse, type NextRequest } from 'next/server';
import { isPublishedPage } from './lib/page-index.ts';

/** Paths that are not content pages: framework assets, metadata files, internal endpoints. */
const NOT_A_PAGE =
  /^\/(?:_next\/|__cms\/|%5F%5Fcms\/|_cms\/|favicon\.ico$|sitemap\.xml$|robots\.txt$)/i;

/**
 * Next.js 16 renders `notFound()` and errors thrown by a dynamic page as an empty error shell
 * that the browser fills in. For anonymous visitors the proxy answers those cases itself by
 * rewriting to prerendered pages, so the HTML served is complete and valid (TECHNICAL §11).
 * Signed-in users go through: they may see drafts (FR-150).
 */
async function pageStatus(request: NextRequest): Promise<'ok' | 'missing' | 'unavailable'> {
  const path = request.nextUrl.pathname;
  if (NOT_A_PAGE.test(path)) return 'ok';
  if (request.method !== 'GET' && request.method !== 'HEAD') return 'ok';
  const publicPath = normalizePublicPath(path);
  if (!pageNodeFromPath(publicPath)) return 'missing';
  if (request.cookies.has(SESSION_COOKIE)) return 'ok';
  try {
    return (await isPublishedPage(publicPath)) ? 'ok' : 'missing';
  } catch {
    return 'unavailable';
  }
}

export async function proxy(request: NextRequest) {
  const status = await pageStatus(request);
  if (status === 'missing') {
    return NextResponse.rewrite(new URL('/_not-found', request.url), { status: 404 });
  }
  if (status === 'unavailable') {
    return NextResponse.rewrite(new URL('/__cms/unavailable', request.url), {
      status: 503,
      headers: { 'retry-after': '30' },
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
