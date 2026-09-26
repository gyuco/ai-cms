import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Me } from './api.ts';
import { clampRect, defaultRect, type Rect, type Size } from './geometry.ts';
import { isToggleShortcut } from './keys.ts';
import { Panel, PANEL_ID } from './panel.tsx';
import { loadState, saveState, type WidgetState } from './storage.ts';
import type { TabId } from './tabs/index.ts';

function readViewport(): Size {
  const root = document.documentElement;
  // clientWidth excludes the page scrollbar, so the panel never sits under it.
  return {
    width: root.clientWidth || window.innerWidth,
    height: root.clientHeight || window.innerHeight,
  };
}

function useViewport(): Size {
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    const onResize = () => setViewport(readViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewport;
}

/** Floating launcher button plus the movable, resizable panel (E7.3). */
export function Shell({ me }: { me: Me }) {
  const [state, setState] = useState<WidgetState>(() => loadState());
  const viewport = useViewport();
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Focus moves only after an explicit open/close, never when the page restores an open panel.
  const pendingFocus = useRef<'panel' | 'launcher' | null>(null);

  useEffect(() => saveState(state), [state]);

  const toggle = useCallback((open?: boolean) => {
    setState((current) => {
      const next = open ?? !current.open;
      if (next === current.open) return current;
      pendingFocus.current = next ? 'panel' : 'launcher';
      return { ...current, open: next };
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isToggleShortcut(event)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === 'panel') {
      panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    } else if (target === 'launcher') {
      launcherRef.current?.focus();
    }
  }, [state.open]);

  const rect = clampRect(state.rect ?? defaultRect(viewport), viewport);
  const setRect = useCallback((next: Rect) => setState((s) => ({ ...s, rect: next })), []);
  const setTab = useCallback((tab: TabId) => setState((s) => ({ ...s, tab })), []);

  return (
    <div class="root">
      <button
        ref={launcherRef}
        type="button"
        class={`launcher env-${me.env}`}
        aria-expanded={state.open}
        aria-controls={PANEL_ID}
        aria-keyshortcuts="Control+Period Meta+Period"
        aria-label={state.open ? 'Chiudi il pannello del CMS' : 'Apri il pannello del CMS'}
        title={`${state.open ? 'Chiudi' : 'Apri'} il CMS (Ctrl+.)`}
        onClick={() => toggle()}
      >
        <span aria-hidden="true">CMS</span>
      </button>
      <Panel
        panelRef={panelRef}
        me={me}
        open={state.open}
        rect={rect}
        viewport={viewport}
        tab={state.tab}
        onRectChange={setRect}
        onTabChange={setTab}
        onClose={() => toggle(false)}
      />
    </div>
  );
}
