import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, loadState, saveState, STORAGE_KEY, type WidgetState } from './storage.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const saved: WidgetState = {
  open: true,
  rect: { x: 10, y: 20, width: 400, height: 500 },
  tab: 'site',
};

describe('widget state persistence', () => {
  it('round-trips the state', () => {
    const storage = memoryStorage();
    saveState(saved, () => storage);
    expect(storage.data.has(STORAGE_KEY)).toBe(true);
    expect(loadState(() => storage)).toEqual(saved);
  });

  it('starts from the initial state when nothing is stored', () => {
    expect(loadState(() => memoryStorage())).toEqual(INITIAL_STATE);
    expect(loadState(() => null)).toEqual(INITIAL_STATE);
  });

  it('ignores corrupted or unknown values', () => {
    expect(loadState(() => memoryStorage({ [STORAGE_KEY]: '{not json' }))).toEqual(INITIAL_STATE);
    const odd = JSON.stringify({ open: 'yes', rect: { x: 'a' }, tab: 'nope' });
    expect(loadState(() => memoryStorage({ [STORAGE_KEY]: odd }))).toEqual(INITIAL_STATE);
  });

  it('survives storage that throws on access, read or write', () => {
    const throwing = () => {
      throw new Error('SecurityError');
    };
    expect(loadState(throwing)).toEqual(INITIAL_STATE);
    expect(() => saveState(saved, throwing)).not.toThrow();

    const broken = { getItem: throwing, setItem: throwing };
    expect(loadState(() => broken)).toEqual(INITIAL_STATE);
    expect(() => saveState(saved, () => broken)).not.toThrow();
  });
});
