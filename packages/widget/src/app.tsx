import { useEffect, useState } from 'preact/hooks';
import { fetchMe, type Me } from './api.ts';
import { Shell } from './shell.tsx';

/**
 * Root component rendered inside the shadow root. Without a valid session (401) the widget
 * renders nothing and clears the `cms_ui` hint cookie.
 */
export function App({ fetchFn }: { fetchFn?: typeof fetch }) {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMe(fetchFn).then(
      (result) => {
        if (!cancelled) setMe(result);
      },
      (error: unknown) => console.warn('[cms-widget] impossibile caricare la sessione', error),
    );
    return () => {
      cancelled = true;
    };
  }, [fetchFn]);

  return me ? <Shell me={me} /> : null;
}
