import { listPublishedPages, publicPathFromNode, siteEnv } from '@ai-cms/site-kit/data';

/**
 * Public paths of the published pages, kept in process memory for the proxy. Next.js 16
 * renders a `notFound()` thrown by a dynamic page as an empty error shell filled in by the
 * browser; answering unknown paths from the proxy with the prerendered 404 page keeps the
 * served HTML complete and valid for visitors and crawlers.
 */
interface PageIndex {
  paths: Set<string>;
  expiresAt: number;
}

const TTL_MS = 30_000;
// Shared through globalThis: the proxy and the route handlers are bundled separately.
const store = globalThis as typeof globalThis & {
  __cmsPageIndex?: PageIndex;
  __cmsPageIndexLoading?: Promise<PageIndex>;
  __cmsPageIndexGeneration?: number;
};

async function load(): Promise<PageIndex> {
  const entries = await listPublishedPages(siteEnv());
  const paths = new Set<string>();
  for (const entry of entries) {
    const path = publicPathFromNode(entry.path);
    if (path) paths.add(path);
  }
  return { paths, expiresAt: Date.now() + TTL_MS };
}

/** Whether a public path is a published page. Throws when the database is unreachable. */
export async function isPublishedPage(publicPath: string): Promise<boolean> {
  let index = store.__cmsPageIndex;
  if (!index || index.expiresAt <= Date.now()) {
    const generation = store.__cmsPageIndexGeneration ?? 0;
    const loading = (store.__cmsPageIndexLoading ??= load());
    try {
      index = await loading;
    } finally {
      if (store.__cmsPageIndexLoading === loading) store.__cmsPageIndexLoading = undefined;
    }
    // An invalidation during the load makes the result stale: use it, but do not keep it.
    if ((store.__cmsPageIndexGeneration ?? 0) === generation) store.__cmsPageIndex = index;
  }
  return index.paths.has(publicPath);
}

/** Forgets the index; called after a revalidation. */
export function invalidatePageIndex(): void {
  store.__cmsPageIndexGeneration = (store.__cmsPageIndexGeneration ?? 0) + 1;
  store.__cmsPageIndex = undefined;
  store.__cmsPageIndexLoading = undefined;
}
