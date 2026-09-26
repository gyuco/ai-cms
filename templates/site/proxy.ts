import {
  NONCE_HEADER,
  SESSION_COOKIE,
  contentSecurityPolicy,
  fetchDraft,
  generateNonce,
  normalizePublicPath,
  pageNodeFromPath,
  siteEnv,
} from '@ai-cms/site-kit/data';
import { NextResponse, type NextRequest } from 'next/server';
import { isPublishedPage } from './lib/page-index.ts';
import { PATH_HEADER } from './lib/request.ts';

/** Paths that are not content pages: framework assets, metadata files, internal endpoints. */
const NOT_A_PAGE =
  /^\/(?:_next\/|__cms\/|%5F%5Fcms\/|_cms\/|favicon\.ico$|sitemap\.xml$|robots\.txt$)/i;

/**
 * Next.js 16 renders `notFound()` and errors thrown by a dynamic page as an empty error shell
 * that the browser fills in. For anonymous visitors the proxy answers those cases itself by
 * rewriting to 404 and 503 pages that render without content, so the HTML served is complete
 * and valid (TECHNICAL §11). For signed-in users a path that is not published may still have
 * a draft (FR-150): cms-api is asked before answering 404.
 */
async function pageStatus(request: NextRequest): Promise<'ok' | 'missing' | 'unavailable'> {
  const path = request.nextUrl.pathname;
  if (NOT_A_PAGE.test(path)) return 'ok';
  if (request.method !== 'GET' && request.method !== 'HEAD') return 'ok';
  const publicPath = normalizePublicPath(path);
  if (!pageNodeFromPath(publicPath)) return 'missing';
  try {
    if (await isPublishedPage(publicPath)) return 'ok';
  } catch {
    return 'unavailable';
  }
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (!session) return 'missing';
  const draft = await fetchDraft({ publicPath, env: siteEnv(), sessionToken: session });
  // On errors the page decides (and falls back to the published content).
  return draft.status === 'not-found' || draft.status === 'denied' ? 'missing' : 'ok';
}

/** Adds the CSP to a response. */
function secured(response: NextResponse, csp: string): NextResponse {
  response.headers.set('content-security-policy', csp);
  return response;
}

export async function proxy(request: NextRequest) {
  const status = await pageStatus(request);

  // A fresh nonce per request (E6.8). Next.js reads it from the request's CSP header and puts
  // it on its own scripts; the layout reads `x-nonce` for the widget loader.
  const nonce = generateNonce();
  const csp = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === 'development' });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set('content-security-policy', csp);
  // Never trust the path header from the client: it is ours only when the proxy sets it.
  requestHeaders.delete(PATH_HEADER);

  if (status === 'unavailable') {
    const response = NextResponse.rewrite(new URL('/__cms/unavailable', request.url), {
      status: 503,
      headers: { 'retry-after': '30' },
      request: { headers: requestHeaders },
    });
    return secured(response, csp);
  }
  requestHeaders.set(PATH_HEADER, normalizePublicPath(request.nextUrl.pathname));
  if (status === 'missing') {
    const response = NextResponse.rewrite(new URL('/_not-found', request.url), {
      status: 404,
      request: { headers: requestHeaders },
    });
    return secured(response, csp);
  }
  return secured(NextResponse.next({ request: { headers: requestHeaders } }), csp);
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
