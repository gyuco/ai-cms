import { describe, expect, it } from 'vitest';
import type { Block } from './blocks.ts';
import { applyBlockPatch } from './patch.ts';

const p = (id: string, text = id): Block => ({ id, type: 'paragraph', content: [{ text }] });
const blocks: Block[] = [
  p('a'),
  { id: 's', type: 'section', tag: 'section', children: [p('b'), p('c')] },
];

const ids = (list: Block[]): unknown =>
  list.map((b) => (b.type === 'section' ? { [b.id]: ids(b.children) } : b.id));

describe('applyBlockPatch', () => {
  it('updates, inserts, moves and removes blocks by id', () => {
    const result = applyBlockPatch(blocks, [
      { op: 'update', id: 'b', fields: { content: [{ text: 'Nuovo' }] } },
      { op: 'insert', block: p('d'), after: 'b' },
      { op: 'insert', block: p('top'), parentId: null, index: 0 },
      { op: 'move', id: 'a', parentId: 's' },
      { op: 'remove', id: 'c' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ids(result.value)).toEqual(['top', { s: ['b', 'd', 'a'] }]);
    expect(result.value[1]).toMatchObject({ children: [{ content: [{ text: 'Nuovo' }] }, {}, {}] });
    // The input is not mutated.
    expect(ids(blocks)).toEqual(['a', { s: ['b', 'c'] }]);
  });

  it('assigns ids to inserted blocks that lack one', () => {
    const result = applyBlockPatch(blocks, [
      { op: 'insert', block: { type: 'heading', level: 2, text: 'Titolo' }, before: 'a' },
    ]);
    expect(result.ok && result.value[0]!.id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('reports every failing operation', () => {
    const result = applyBlockPatch(blocks, [
      { op: 'remove', id: 'zzz' },
      { op: 'update', id: 'a', fields: { type: 'heading' } },
      { op: 'move', id: 's', parentId: 's' },
      { op: 'insert', block: p('b') },
      { op: 'insert', block: p('x'), parentId: 'a' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toEqual([
      'operations[0]',
      'operations[1]',
      'operations[2]',
      'operations[3]',
      'operations[4]',
    ]);
    expect(result.errors[0]!.message).toContain('non esiste');
    expect(result.errors[4]!.message).toContain('non è una sezione');
  });
});
