import { describe, expect, it } from 'vitest';
import { clampRect, defaultRect, isRect, MIN_SIZE, moveRect, resizeRect } from './geometry.ts';

const viewport = { width: 1200, height: 800 };

describe('clampRect', () => {
  it('leaves a rectangle inside the viewport unchanged', () => {
    const rect = { x: 100, y: 50, width: 400, height: 500 };
    expect(clampRect(rect, viewport)).toEqual(rect);
  });

  it('moves a rectangle back inside when it falls off any edge', () => {
    expect(clampRect({ x: -40, y: -10, width: 400, height: 500 }, viewport)).toMatchObject({
      x: 0,
      y: 0,
    });
    expect(clampRect({ x: 1000, y: 700, width: 400, height: 500 }, viewport)).toMatchObject({
      x: 800,
      y: 300,
    });
  });

  it('repositions the panel when the window shrinks', () => {
    const rect = { x: 700, y: 250, width: 440, height: 560 };
    expect(clampRect(rect, { width: 800, height: 600 })).toEqual({
      x: 360,
      y: 40,
      width: 440,
      height: 560,
    });
  });

  it('shrinks the panel to the viewport, and never below the minimum size otherwise', () => {
    expect(clampRect({ x: 0, y: 0, width: 2000, height: 2000 }, viewport)).toEqual({
      x: 0,
      y: 0,
      ...viewport,
    });
    expect(clampRect({ x: 10, y: 10, width: 50, height: 50 }, viewport)).toMatchObject(MIN_SIZE);
    expect(
      clampRect({ x: 10, y: 10, width: 400, height: 400 }, { width: 300, height: 200 }),
    ).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });
});

describe('defaultRect', () => {
  it('places the panel at the bottom right, above the launcher', () => {
    const rect = defaultRect(viewport);
    expect(rect.x + rect.width).toBe(viewport.width - 16);
    expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height - 80);
  });

  it('fits small viewports', () => {
    expect(defaultRect({ width: 360, height: 500 })).toEqual({
      x: 0,
      y: 0,
      width: 360,
      height: 500,
    });
  });
});

describe('moveRect and resizeRect', () => {
  const rect = { x: 100, y: 100, width: 400, height: 400 };

  it('moves within the viewport', () => {
    expect(moveRect(rect, 50, -20, viewport)).toMatchObject({ x: 150, y: 80 });
    expect(moveRect(rect, -500, 5000, viewport)).toMatchObject({ x: 0, y: 400 });
  });

  it('resizes from the bottom-right corner without moving the panel', () => {
    expect(resizeRect(rect, 100, 50, viewport)).toEqual({ ...rect, width: 500, height: 450 });
    expect(resizeRect(rect, -1000, -1000, viewport)).toEqual({ ...rect, ...MIN_SIZE });
    expect(resizeRect(rect, 5000, 5000, viewport)).toEqual({
      ...rect,
      width: 1100,
      height: 700,
    });
  });
});

describe('isRect', () => {
  it('accepts only finite numeric rectangles', () => {
    expect(isRect({ x: 1, y: 2, width: 3, height: 4 })).toBe(true);
    expect(isRect({ x: 1, y: 2, width: '3', height: 4 })).toBe(false);
    expect(isRect({ x: 1, y: 2, width: Infinity, height: 4 })).toBe(false);
    expect(isRect(null)).toBe(false);
  });
});
