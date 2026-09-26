import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import {
  blockAt,
  blockKind,
  blockRef,
  findBlock,
  listBlocks,
  selection,
  useSelection,
  type BlockRef,
} from './selection.ts';

/** Most blocks outlined at once: beyond this the outlines would only add noise. */
const MAX_OUTLINES = 300;

function useRepaintOnScroll(active: boolean): void {
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => repaint(undefined));
    };
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
    };
  }, [active]);
}

function Outline({
  element,
  variant,
  label,
}: {
  element: Element;
  variant: string;
  label?: string;
}) {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return (
    <div
      class={`block-outline ${variant}`}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      aria-hidden="true"
    >
      {label && <span class="block-label">{label}</span>}
    </div>
  );
}

interface OverlayProps {
  /** Block highlighted from the keyboard list in the panel. */
  preview: Element | null;
  fallbackPath: string | null;
}

/**
 * Overlays positioned above the page (TECHNICAL §10.2): while selecting, a transparent layer
 * catches the clicks and outlines every block; afterwards it only marks the selected block.
 */
export function SelectionOverlay({ preview, fallbackPath }: OverlayProps) {
  const { selecting, selected } = useSelection();
  const [hover, setHover] = useState<Element | null>(null);
  useRepaintOnScroll(selecting || selected !== null);

  useEffect(() => {
    if (!selecting) {
      setHover(null);
      return;
    }
    // Capture phase on window: Esc cancels the selection before it can close the panel.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      selection.cancel();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [selecting]);

  const blocks = useMemo(() => (selecting ? listBlocks().slice(0, MAX_OUTLINES) : []), [selecting]);

  if (!selecting) {
    const element = selected ? findBlock(selected) : null;
    return element ? <Outline element={element} variant="selected" /> : null;
  }

  const pick = (event: MouseEvent) =>
    blockAt(document.elementsFromPoint(event.clientX, event.clientY));
  const active = hover ?? preview;
  return (
    <>
      {blocks.map((element, index) => (
        <Outline key={index} element={element} variant="candidate" />
      ))}
      {active && (
        <Outline
          element={active}
          variant="active"
          label={`${blockKind(active)} · ${blockRef(active).text}`}
        />
      )}
      <div
        class="select-layer"
        aria-hidden="true"
        onPointerMove={(event) => setHover(pick(event))}
        onPointerLeave={() => setHover(null)}
        onClick={(event) => {
          event.preventDefault();
          const block = pick(event);
          if (block) selection.select(blockRef(block, fallbackPath));
        }}
      />
    </>
  );
}

interface BarProps {
  fallbackPath: string | null;
  onPreview: (element: Element | null) => void;
}

/** The keyboard alternative to clicking: the list of the page's blocks, in the panel. */
export function SelectionBar({ fallbackPath, onPreview }: BarProps) {
  const { selecting, selected } = useSelection();
  const listRef = useRef<HTMLUListElement>(null);
  const blocks = useMemo(() => (selecting ? listBlocks() : []), [selecting]);

  useEffect(() => {
    if (!selecting) return;
    listRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => onPreview(null);
  }, [selecting, onPreview]);

  if (selecting) {
    const choose = (element: Element) => selection.select(blockRef(element, fallbackPath));
    return (
      <section class="selectbar" aria-labelledby="cms-select-title">
        <p id="cms-select-title" class="selectbar-title">
          Fai clic su un elemento della pagina oppure sceglilo dall'elenco. Esc per annullare.
        </p>
        {blocks.length === 0 ? (
          <p class="muted">In questa pagina non ci sono elementi selezionabili.</p>
        ) : (
          <ul ref={listRef} class="block-list" aria-label="Elementi della pagina">
            {blocks.map((element, index) => {
              const ref = blockRef(element, fallbackPath);
              return (
                <li key={index}>
                  <button
                    type="button"
                    class="block-choice"
                    onFocus={() => {
                      onPreview(element);
                      element.scrollIntoView({ block: 'nearest' });
                    }}
                    onMouseEnter={() => onPreview(element)}
                    onClick={() => choose(element)}
                  >
                    <span class="block-kind">{blockKind(element)}</span> {ref.text}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <button type="button" class="button secondary small" onClick={() => selection.cancel()}>
          Annulla
        </button>
      </section>
    );
  }

  if (!selected) return null;
  return <SelectedChip selected={selected} />;
}

function SelectedChip({ selected }: { selected: BlockRef }) {
  return (
    <div class="selected-chip">
      <span class="selected-text">
        <span class="muted">Elemento selezionato:</span> <strong>{selected.text}</strong>
      </span>
      <button
        type="button"
        class="link-button"
        aria-label={`Rimuovi la selezione di ${selected.text}`}
        onClick={() => selection.clear()}
      >
        Rimuovi
      </button>
    </div>
  );
}
