import { useEffect, useState } from 'preact/hooks';
import type { Api } from '../api.ts';
import { errorMessage } from '../tabs/common.tsx';
import { applyPreview, type PlanPagePreview } from './preview.ts';
import type { PlanView } from './stream.ts';

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  /** The plan does not touch the page the person is looking at. */
  | { status: 'elsewhere' }
  | { status: 'shown'; removed: PlanPagePreview['removed']; highlighted: number }
  | { status: 'error'; message: string };

/**
 * Shows the plan waiting in the chat on the page itself (E7.5): fetches the page as the plan
 * would leave it and swaps it into `<main>` while `enabled`. Whatever ends the preview — an
 * answer to the plan, switching it off, moving to another page — puts the original back.
 */
export function usePlanPreview(
  api: Api,
  plan: PlanView | null,
  conversationId: string | null,
  path: string | null,
  enabled: boolean,
): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  // Re-fetch when the plan changes, not on every render: its steps are its identity.
  const planKey = plan ? JSON.stringify(plan.steps) : '';

  useEffect(() => {
    if (!plan || !conversationId || !path || !enabled) {
      setState({ status: 'idle' });
      return;
    }
    if (!plan.pages.some((page) => page.path === path)) {
      setState({ status: 'elsewhere' });
      return;
    }
    let cancelled = false;
    let restore: (() => void) | undefined;
    setState({ status: 'loading' });
    api
      .get<{ preview: PlanPagePreview | null }>('/chat/plan/preview', { conversationId, path })
      .then(({ preview }) => {
        if (cancelled) return;
        const applied = preview ? applyPreview(document, preview) : null;
        if (!preview || !applied) return setState({ status: 'elsewhere' });
        restore = applied.restore;
        setState({ status: 'shown', removed: preview.removed, highlighted: applied.highlighted });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
      restore?.();
    };
  }, [api, planKey, conversationId, path, enabled]);

  return state;
}
