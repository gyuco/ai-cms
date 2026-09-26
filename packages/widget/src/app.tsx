import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { createApi, fetchContext, type WidgetContext } from './api.ts';
import { Shell } from './shell.tsx';
import { WidgetState, type WidgetValue } from './widget-context.ts';

/**
 * Root component rendered inside the shadow root. Without a valid session (401) the widget
 * renders nothing and clears the `cms_ui` hint cookie.
 */
export function App({ fetchFn }: { fetchFn?: typeof fetch }) {
  const [context, setContext] = useState<WidgetContext | null>(null);

  const load = useCallback(
    () =>
      fetchContext(location.pathname, fetchFn).then(
        (result) => setContext(result),
        (error: unknown) => console.warn('[cms-widget] impossibile caricare il contesto', error),
      ),
    [fetchFn],
  );

  useEffect(() => {
    let cancelled = false;
    fetchContext(location.pathname, fetchFn).then(
      (result) => {
        if (!cancelled) setContext(result);
      },
      (error: unknown) => console.warn('[cms-widget] impossibile caricare il contesto', error),
    );
    return () => {
      cancelled = true;
    };
  }, [fetchFn]);

  const csrfToken = context?.csrfToken;
  const api = useMemo(() => createApi(csrfToken ?? '', fetchFn), [csrfToken, fetchFn]);
  const value = useMemo<WidgetValue | null>(
    () => (context ? { context, api, reload: load } : null),
    [context, api, load],
  );

  return value ? (
    <WidgetState.Provider value={value}>
      <Shell me={value.context} pagePath={value.context.node?.path ?? null} />
    </WidgetState.Provider>
  ) : null;
}
