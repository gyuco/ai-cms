import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { logout, otherEnv, requestEnvSwitch, type Env, type Me } from './api.ts';
import { moveRect, resizeRect, type Rect, type Size } from './geometry.ts';
import { arrowDelta, nextTabIndex } from './keys.ts';
import { SelectionBar } from './selection-ui.tsx';
import { selection, useSelection } from './selection.ts';
import { TABS, type TabId } from './tabs/index.ts';

export const PANEL_ID = 'cms-panel';
const TITLE_ID = 'cms-panel-title';
const ENV_ID = 'cms-panel-env';

export const ENV_LABEL: Record<Env, string> = { prod: 'Produzione', staging: 'Staging' };

interface PanelProps {
  panelRef: RefObject<HTMLDivElement>;
  me: Me;
  open: boolean;
  rect: Rect;
  viewport: Size;
  tab: TabId;
  onRectChange: (rect: Rect) => void;
  onTabChange: (tab: TabId) => void;
  onClose: () => void;
  /** Node of the current page, for blocks outside any `data-cms-node`. */
  pagePath: string | null;
  onPreview: (element: Element | null) => void;
}

interface PointerDrag {
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  rect: Rect;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Si è verificato un errore. Riprova tra poco.';
}

/** Non-modal dialog: the page stays usable while the panel is open (TECHNICAL §10.2). */
export function Panel(props: PanelProps) {
  const { me, rect, viewport, onRectChange } = props;
  const drag = useRef<PointerDrag | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { selecting, selected } = useSelection();
  const selectButton = useRef<HTMLButtonElement>(null);
  const wasSelecting = useRef(false);

  // Back to the toggle once a block is chosen or the selection is cancelled.
  useEffect(() => {
    if (wasSelecting.current && !selecting && props.open) selectButton.current?.focus();
    wasSelecting.current = selecting;
  }, [selecting, props.open]);

  const startDrag = (mode: PointerDrag['mode']) => (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (mode === 'move' && (event.target as Element).closest('button, a')) return;
    drag.current = { mode, startX: event.clientX, startY: event.clientY, rect };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    onRectChange(
      current.mode === 'move'
        ? moveRect(current.rect, dx, dy, viewport)
        : resizeRect(current.rect, dx, dy, viewport),
    );
  };
  const endDrag = () => {
    drag.current = null;
  };

  const onTitlebarKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    const delta = arrowDelta(event);
    if (!delta) return;
    event.preventDefault();
    onRectChange(moveRect(rect, delta[0], delta[1], viewport));
  };
  const onResizeKeyDown = (event: KeyboardEvent) => {
    const delta = arrowDelta(event);
    if (!delta) return;
    event.preventDefault();
    onRectChange(resizeRect(rect, delta[0], delta[1], viewport));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    props.onClose();
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  const switchEnv = () =>
    run(async () => {
      const url = await requestEnvSwitch(me, location.pathname + location.search);
      location.assign(url);
    });
  const signOut = () =>
    run(async () => {
      await logout(me);
      location.reload();
    });

  const target = otherEnv(me.env);
  const userName = me.user.displayName || me.user.username;
  const passwordUrl = `/_cms/password?returnTo=${encodeURIComponent(location.pathname + location.search)}`;

  return (
    <div
      ref={props.panelRef}
      id={PANEL_ID}
      class={`panel env-${me.env}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${TITLE_ID} ${ENV_ID}`}
      hidden={!props.open}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onKeyDown={onKeyDown}
    >
      <div
        class="titlebar"
        role="group"
        tabIndex={0}
        aria-label="Barra del titolo: usa le frecce per spostare il pannello"
        onPointerDown={startDrag('move')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onTitlebarKeyDown}
      >
        <span class="grip" aria-hidden="true" />
        <h2 id={TITLE_ID} class="title">
          AI-CMS
        </h2>
        <span id={ENV_ID} class={`env-badge env-${me.env}`}>
          {ENV_LABEL[me.env]}
        </span>
        <button
          ref={selectButton}
          type="button"
          class="icon-button push"
          aria-pressed={selecting}
          aria-label="Seleziona un elemento della pagina"
          title="Seleziona un elemento della pagina"
          onClick={() => (selecting ? selection.cancel() : selection.start())}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <circle cx="8" cy="8" r="4.5" fill="none" />
            <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
          </svg>
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label="Chiudi il pannello"
          title="Chiudi (Esc)"
          onClick={props.onClose}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      <div class="userbar">
        <p class="user" title={me.user.email}>
          <span class="visually-hidden">Utente: </span>
          {userName}
        </p>
        <button type="button" class="button" disabled={busy} onClick={switchEnv}>
          Passa a {ENV_LABEL[target]}
        </button>
        <button type="button" class="button secondary" disabled={busy} onClick={signOut}>
          Esci
        </button>
      </div>

      {me.user.mustChangePassword && (
        <p class="notice">
          Devi cambiare la password prima di continuare. <a href={passwordUrl}>Cambiala ora</a>
        </p>
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      <SelectionBar fallbackPath={props.pagePath} onPreview={props.onPreview} />
      <p class="visually-hidden" aria-live="polite">
        {selecting
          ? 'Modalità selezione attiva.'
          : selected
            ? `Elemento selezionato: ${selected.text}.`
            : ''}
      </p>

      <Tabs tab={props.tab} onTabChange={props.onTabChange} />

      <button
        type="button"
        class="resize-handle"
        aria-label="Ridimensiona il pannello: usa le frecce"
        onPointerDown={startDrag('resize')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onResizeKeyDown}
      />
    </div>
  );
}

function Tabs({ tab, onTabChange }: { tab: TabId; onTabChange: (tab: TabId) => void }) {
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  const onKeyDown = (event: KeyboardEvent) => {
    const index = TABS.findIndex((t) => t.id === current.id);
    const next = nextTabIndex(event.key, index, TABS.length);
    if (next === null) return;
    event.preventDefault();
    onTabChange(TABS[next]!.id);
    const tabs = (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]');
    tabs[next]?.focus();
  };

  return (
    <>
      <div class="tablist" role="tablist" aria-label="Sezioni del CMS" onKeyDown={onKeyDown}>
        {TABS.map((t) => {
          const selected = t.id === current.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`cms-tab-${t.id}`}
              class="tab"
              aria-selected={selected}
              aria-controls={`cms-tabpanel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTabChange(t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {/* Every panel exists so each tab's aria-controls resolves; only the selected one renders. */}
      {TABS.map((t) => (
        <div
          key={t.id}
          class="tabpanel"
          role="tabpanel"
          id={`cms-tabpanel-${t.id}`}
          aria-labelledby={`cms-tab-${t.id}`}
          tabIndex={0}
          hidden={t.id !== current.id}
        >
          {t.id === current.id && <t.Component />}
        </div>
      ))}
    </>
  );
}
