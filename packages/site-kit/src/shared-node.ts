import type { SiteEnv } from './config.ts';
import { fetchDraft, type DraftRequest, type DraftResult } from './preview.ts';

export interface SharedNodeSources {
  env: SiteEnv;
  /** The `cms_session` cookie of the visitor, if any. */
  session?: string | undefined;
  /** Published body of the node (cached: shared by every visitor). */
  published: () => Promise<{ body: unknown } | null>;
  /** Overridable in tests. */
  draft?: (request: DraftRequest) => Promise<DraftResult>;
  onError?: (message: string) => void;
}

/**
 * Body of a shared element (settings, header, footer, main menu). A signed-in user sees the
 * latest version even when it is not published yet, as for pages (FR-150); anyone else, and
 * a signed-in user whose draft cannot be read, sees the published one. The draft is never
 * cached: it depends on who is asking.
 */
export async function sharedNodeBody(
  nodePath: string,
  sources: SharedNodeSources,
): Promise<unknown> {
  if (sources.session) {
    const draft = await (sources.draft ?? fetchDraft)({
      nodePath,
      env: sources.env,
      sessionToken: sources.session,
    });
    if (draft.status === 'ok') return draft.body;
    if (draft.status === 'error') {
      sources.onError?.(`site: anteprima non disponibile per ${nodePath}: ${draft.message}`);
    }
  }
  return (await sources.published())?.body ?? null;
}
