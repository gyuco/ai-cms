import { describe, expect, it } from 'vitest';
import { diffBodies } from './diff.ts';

const h = (id: string, text: string) => ({ id, type: 'heading', level: 2, text });
const p = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });

describe('diffBodies', () => {
  it('reports no change for equal bodies, whatever the key order', () => {
    const a = { meta: { title: 'A', lang: 'it' }, blocks: [h('a', 'Uno')] };
    const b = {
      blocks: [{ text: 'Uno', level: 2, type: 'heading', id: 'a' }],
      meta: { lang: 'it', title: 'A' },
    };
    expect(diffBodies(a, b).changed).toBe(false);
  });

  it('finds added, removed and modified blocks by id, nested ones included', () => {
    const before = {
      meta: { title: 'Prima' },
      blocks: [
        h('a', 'Titolo'),
        { id: 's', type: 'section', tag: 'section', children: [p('p1', 'uno'), p('p2', 'due')] },
      ],
    };
    const after = {
      meta: { title: 'Dopo', description: 'Nuova' },
      blocks: [
        h('a', 'Titolo nuovo'),
        { id: 's', type: 'section', tag: 'section', children: [p('p1', 'uno'), p('p3', 'tre')] },
      ],
    };
    const diff = diffBodies(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.blocks.added).toEqual([{ id: 'p3', type: 'paragraph', parentId: 's', index: 1 }]);
    expect(diff.blocks.removed).toEqual([{ id: 'p2', type: 'paragraph', parentId: 's', index: 1 }]);
    // The section itself is unchanged: only its children changed.
    expect(diff.blocks.modified.map((m) => m.id)).toEqual(['a']);
    expect(diff.blocks.moved).toEqual([]);
    expect(diff.fields).toEqual([
      { field: 'meta.description', before: undefined, after: 'Nuova' },
      { field: 'meta.title', before: 'Prima', after: 'Dopo' },
    ]);
  });

  it('reports moves across sections and reorderings, not index shifts', () => {
    const before = {
      meta: {},
      blocks: [
        p('a', 'a'),
        p('b', 'b'),
        p('c', 'c'),
        { id: 's', type: 'section', tag: 'div', children: [] },
      ],
    };
    const after = {
      meta: {},
      blocks: [
        p('new', 'n'),
        p('c', 'c'),
        p('a', 'a'),
        { id: 's', type: 'section', tag: 'div', children: [p('b', 'b')] },
      ],
    };
    const diff = diffBodies(before, after);
    // a and c swapped: one of them moved; the insertion of `new` shifts nothing.
    const moved = diff.blocks.moved.map((m) => m.id);
    expect(moved).toHaveLength(2);
    expect(moved).toContain('b');
    expect(moved.some((id) => id === 'a' || id === 'c')).toBe(true);
    expect(diff.blocks.moved.find((m) => m.id === 'b')).toMatchObject({
      from: { parentId: null, index: 1 },
      to: { parentId: 's', index: 0 },
    });
  });

  it('compares top-level fields for bodies without meta', () => {
    const diff = diffBodies({ name: 'A', lang: 'it' }, { name: 'B', lang: 'it' });
    expect(diff.fields).toEqual([{ field: 'name', before: 'A', after: 'B' }]);
    expect(diff.blocks.added).toEqual([]);
  });
});
