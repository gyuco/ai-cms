import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { Api, WidgetContext } from './api.ts';

export interface WidgetValue {
  context: WidgetContext;
  api: Api;
  /** Fetches the page context again, e.g. after the page was created or published. */
  reload: () => Promise<void>;
}

export const WidgetState = createContext<WidgetValue | null>(null);

/** Session, page context and API client, for the tabs. */
export function useWidget(): WidgetValue {
  const value = useContext(WidgetState);
  if (!value) throw new Error('useWidget outside of <App>');
  return value;
}
