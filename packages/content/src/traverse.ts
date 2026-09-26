import type { Block, HeadingLevel } from './blocks.ts';

export interface OutlineEntry {
  id: string;
  level: HeadingLevel;
  text: string;
}

/** Depth-first walk over all blocks, sections' children included, in document order. */
export function* walkBlocks(blocks: readonly Block[]): Generator<Block> {
  for (const block of blocks) {
    yield block;
    if (block.type === 'section') yield* walkBlocks(block.children);
  }
}

/** Headings in document order (TECHNICAL §11.3). */
export function outline(blocks: readonly Block[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  for (const block of walkBlocks(blocks)) {
    if (block.type === 'heading')
      entries.push({ id: block.id, level: block.level, text: block.text });
  }
  return entries;
}

export function findBlock(blocks: readonly Block[], id: string): Block | undefined {
  for (const block of walkBlocks(blocks)) if (block.id === id) return block;
  return undefined;
}

/**
 * Immutable deep map. `fn` sees each block after its children were mapped; returning the
 * same object keeps it (and unchanged ancestors keep their identity too).
 */
export function mapBlocks(blocks: readonly Block[], fn: (block: Block) => Block): Block[] {
  let changed = false;
  const out = blocks.map((block) => {
    let current = block;
    if (block.type === 'section') {
      const children = mapBlocks(block.children, fn);
      if (children !== block.children) current = { ...block, children };
    }
    const next = fn(current);
    if (next !== block) changed = true;
    return next;
  });
  return changed ? out : (blocks as Block[]);
}

/** Replaces the block with `id` by `update(block)`. Returns the input array if `id` is absent. */
export function updateBlock(
  blocks: readonly Block[],
  id: string,
  update: (block: Block) => Block,
): Block[] {
  return mapBlocks(blocks, (block) => (block.id === id ? update(block) : block));
}

/** Removes the block with `id` (and its children). Returns the input array if `id` is absent. */
export function removeBlock(blocks: readonly Block[], id: string): Block[] {
  let changed = false;
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.id === id) {
      changed = true;
      continue;
    }
    if (block.type === 'section') {
      const children = removeBlock(block.children, id);
      if (children !== block.children) {
        changed = true;
        out.push({ ...block, children });
        continue;
      }
    }
    out.push(block);
  }
  return changed ? out : (blocks as Block[]);
}
