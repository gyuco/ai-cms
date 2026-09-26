import { describe, expect, it } from 'vitest';
import {
  arrowDelta,
  ARROW_STEP,
  ARROW_STEP_LARGE,
  isToggleShortcut,
  nextTabIndex,
} from './keys.ts';

const key = (overrides: Partial<KeyboardEvent>) => ({
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...overrides,
});

describe('isToggleShortcut', () => {
  it('matches Ctrl + . and Cmd + .', () => {
    expect(isToggleShortcut(key({ key: '.', code: 'Period', ctrlKey: true }))).toBe(true);
    expect(isToggleShortcut(key({ key: '.', code: 'Period', metaKey: true }))).toBe(true);
  });

  it('matches the physical key on layouts where it produces another character', () => {
    expect(isToggleShortcut(key({ key: ':', code: 'Period', ctrlKey: true }))).toBe(true);
  });

  it('ignores the plain key, other keys and Alt combinations', () => {
    expect(isToggleShortcut(key({ key: '.', code: 'Period' }))).toBe(false);
    expect(isToggleShortcut(key({ key: ',', code: 'Comma', ctrlKey: true }))).toBe(false);
    expect(isToggleShortcut(key({ key: '.', code: 'Period', ctrlKey: true, altKey: true }))).toBe(
      false,
    );
  });
});

describe('nextTabIndex', () => {
  it('moves with the arrows and wraps around', () => {
    expect(nextTabIndex('ArrowRight', 0, 7)).toBe(1);
    expect(nextTabIndex('ArrowRight', 6, 7)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 7)).toBe(6);
    expect(nextTabIndex('ArrowLeft', 3, 7)).toBe(2);
  });

  it('jumps to the ends with Home and End', () => {
    expect(nextTabIndex('Home', 4, 7)).toBe(0);
    expect(nextTabIndex('End', 1, 7)).toBe(6);
  });

  it('ignores other keys', () => {
    expect(nextTabIndex('Enter', 1, 7)).toBeNull();
    expect(nextTabIndex('ArrowDown', 1, 7)).toBeNull();
  });
});

describe('arrowDelta', () => {
  it('maps arrows to offsets, with bigger steps when Shift is held', () => {
    expect(arrowDelta({ key: 'ArrowLeft', shiftKey: false })).toEqual([-ARROW_STEP, 0]);
    expect(arrowDelta({ key: 'ArrowDown', shiftKey: false })).toEqual([0, ARROW_STEP]);
    expect(arrowDelta({ key: 'ArrowUp', shiftKey: true })).toEqual([0, -ARROW_STEP_LARGE]);
    expect(arrowDelta({ key: 'ArrowRight', shiftKey: true })).toEqual([ARROW_STEP_LARGE, 0]);
    expect(arrowDelta({ key: 'a', shiftKey: false })).toBeNull();
  });
});
