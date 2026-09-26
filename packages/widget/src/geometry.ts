export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_SIZE: Size = { width: 320, height: 280 };
export const DEFAULT_SIZE: Size = { width: 440, height: 560 };
/** Space between the default panel position and the viewport edges / launcher button. */
const EDGE = 16;
const LAUNCHER_SPACE = 80;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Keeps the panel entirely inside the viewport: the size is limited to the viewport (never
 * below the minimum unless the viewport itself is smaller), then the position is shifted so
 * no edge falls outside.
 */
export function clampRect(rect: Rect, viewport: Size, min: Size = MIN_SIZE): Rect {
  const width = Math.round(clamp(rect.width, Math.min(min.width, viewport.width), viewport.width));
  const height = Math.round(
    clamp(rect.height, Math.min(min.height, viewport.height), viewport.height),
  );
  return {
    x: Math.round(clamp(rect.x, 0, viewport.width - width)),
    y: Math.round(clamp(rect.y, 0, viewport.height - height)),
    width,
    height,
  };
}

/** Bottom-right corner, just above the launcher button. */
export function defaultRect(viewport: Size): Rect {
  return clampRect(
    {
      x: viewport.width - DEFAULT_SIZE.width - EDGE,
      y: viewport.height - DEFAULT_SIZE.height - LAUNCHER_SPACE,
      ...DEFAULT_SIZE,
    },
    viewport,
  );
}

export function moveRect(rect: Rect, dx: number, dy: number, viewport: Size): Rect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, viewport);
}

export function resizeRect(rect: Rect, dw: number, dh: number, viewport: Size): Rect {
  // Grow towards the bottom-right; shrinking never moves the top-left corner.
  const width = clamp(rect.width + dw, MIN_SIZE.width, viewport.width - rect.x);
  const height = clamp(rect.height + dh, MIN_SIZE.height, viewport.height - rect.y);
  return clampRect({ ...rect, width, height }, viewport);
}

export function isRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof r[key] === 'number' && Number.isFinite(r[key]),
  );
}
