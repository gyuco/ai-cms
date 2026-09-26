type KeyInfo = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>;

/** `Ctrl + .` (or `Cmd + .` on macOS) opens and closes the widget (TECHNICAL §10.2). */
export function isToggleShortcut(event: KeyInfo): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  return event.key === '.' || event.code === 'Period';
}

/** Roving focus in a horizontal tablist: arrows wrap around, Home/End jump to the ends. */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count;
    case 'ArrowLeft':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export const ARROW_STEP = 16;
export const ARROW_STEP_LARGE = 64;

/** Offset for moving or resizing the panel with the arrow keys; Shift takes bigger steps. */
export function arrowDelta(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey'>,
): [number, number] | null {
  const step = event.shiftKey ? ARROW_STEP_LARGE : ARROW_STEP;
  switch (event.key) {
    case 'ArrowLeft':
      return [-step, 0];
    case 'ArrowRight':
      return [step, 0];
    case 'ArrowUp':
      return [0, -step];
    case 'ArrowDown':
      return [0, step];
    default:
      return null;
  }
}
