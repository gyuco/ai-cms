import { describe, expect, it } from 'vitest';
import type { Block } from './blocks.ts';
import { findBlock, mapBlocks, outline, removeBlock, updateBlock } from './traverse.ts';

const blocks: Block[] = [
  { id: 'h1', type: 'heading', level: 1, text: 'Titolo' },
  { id: 'p', type: 'paragraph', content: [{ text: 'Testo' }] },
  {
    id: 's',
    type: 'section',
    tag: 'section',
    children: [
      { id: 'h2', type: 'heading', level: 2, text: 'Sezione' },
      {
        id: 'in',
        type: 'section',
        tag: 'div',
        children: [{ id: 'h3', type: 'heading', level: 3, text: 'Sotto' }],
      },
    ],
  },
  { id: 'h2b', type: 'heading', level: 2, text: 'Altra' },
];

describe('traversal', () => {
  it('builds the outline in document order through sections', () => {
    expect(outline(blocks)).toEqual([
      { id: 'h1', level: 1, text: 'Titolo' },
      { id: 'h2', level: 2, text: 'Sezione' },
      { id: 'h3', level: 3, text: 'Sotto' },
      { id: 'h2b', level: 2, text: 'Altra' },
    ]);
  });

  it('finds nested blocks', () => {
    expect(findBlock(blocks, 'h3')).toMatchObject({ text: 'Sotto' });
    expect(findBlock(blocks, 'nope')).toBeUndefined();
  });

  it('updates a nested block immutably, sharing untouched branches', () => {
    const next = updateBlock(blocks, 'h3', (b) =>
      b.type === 'heading' ? { ...b, text: 'Nuovo' } : b,
    );
    expect(findBlock(next, 'h3')).toMatchObject({ text: 'Nuovo' });
    expect(findBlock(blocks, 'h3')).toMatchObject({ text: 'Sotto' });
    expect(next).not.toBe(blocks);
    expect(next[0]).toBe(blocks[0]);
    expect(next[2]).not.toBe(blocks[2]);
    expect(next[3]).toBe(blocks[3]);
  });

  it('returns the same array when nothing changes', () => {
    expect(updateBlock(blocks, 'nope', (b) => ({ ...b }))).toBe(blocks);
    expect(mapBlocks(blocks, (b) => b)).toBe(blocks);
    expect(removeBlock(blocks, 'nope')).toBe(blocks);
  });

  it('removes nested blocks', () => {
    const next = removeBlock(blocks, 'in');
    expect(findBlock(next, 'in')).toBeUndefined();
    expect(findBlock(next, 'h3')).toBeUndefined();
    expect(findBlock(blocks, 'h3')).toBeDefined();
  });
});
