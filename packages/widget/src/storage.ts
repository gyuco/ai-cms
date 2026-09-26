import { isRect, type Rect } from './geometry.ts';
import { isTabId, type TabId } from './tabs/ids.ts';

export interface WidgetState {
  open: boolean;
  /** `null` until the user moves or resizes the panel: the default position is used. */
  rect: Rect | null;
  tab: TabId;
}

export const STORAGE_KEY = 'cms-widget:v1';
export const INITIAL_STATE: WidgetState = { open: false, rect: null, tab: 'chat' };

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

// Accessing localStorage itself can throw (blocked storage, sandboxed frames).
const browserStorage = (): StorageLike | null => globalThis.localStorage ?? null;

export function loadState(getStorage: () => StorageLike | null = browserStorage): WidgetState {
  try {
    const raw = getStorage()?.getItem(STORAGE_KEY);
    if (!raw) return INITIAL_STATE;
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      open: data.open === true,
      rect: isRect(data.rect) ? data.rect : null,
      tab: isTabId(data.tab) ? data.tab : INITIAL_STATE.tab,
    };
  } catch {
    return INITIAL_STATE;
  }
}

export function saveState(
  state: WidgetState,
  getStorage: () => StorageLike | null = browserStorage,
): void {
  try {
    getStorage()?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable: the widget still works, it just forgets its layout.
  }
}
