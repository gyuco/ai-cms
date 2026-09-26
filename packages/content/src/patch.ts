import { z } from 'zod';
import type { Block } from './blocks.ts';
import type { ContentIssue, ParseResult } from './documents.ts';
import { newBlockId } from './ids.ts';
import { findBlock, removeBlock, updateBlock, walkBlocks } from './traverse.ts';

/**
 * Where to put a block: next to a sibling (`after` / `before`), or inside a section
 * (`parentId`, `null` for the top level) at `index` (default: at the end).
 */
const positionFields = {
  parentId: z.string().nullable().optional(),
  index: z.number().int().nonnegative().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
};

export const blockPatchOperationSchema = z.discriminatedUnion(
  'op',
  [
    /** Merges fields into a block; `id` and `type` cannot change. */
    z.strictObject({
      op: z.literal('update'),
      id: z.string(),
      fields: z.record(z.string(), z.unknown()),
    }),
    z.strictObject({ op: z.literal('replace'), id: z.string(), block: z.unknown() }),
    z.strictObject({ op: z.literal('insert'), block: z.unknown(), ...positionFields }),
    z.strictObject({ op: z.literal('remove'), id: z.string() }),
    z.strictObject({ op: z.literal('move'), id: z.string(), ...positionFields }),
  ],
  { error: 'Operazione sui blocchi sconosciuta (update, replace, insert, remove, move)' },
);

export type BlockPatchOperation = z.infer<typeof blockPatchOperationSchema>;
type Position = Pick<
  Extract<BlockPatchOperation, { op: 'insert' }>,
  'parentId' | 'index' | 'after' | 'before'
>;

class PatchFailure extends Error {}

/** Gives an id to blocks (and nested section children) that lack one. */
function withIds(input: unknown): Block {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new PatchFailure('Il blocco deve essere un oggetto');
  }
  const block = { ...(input as Record<string, unknown>) };
  if (block.id === undefined) block.id = newBlockId();
  if (Array.isArray(block.children)) block.children = block.children.map(withIds);
  return block as unknown as Block;
}

/** Id of the section containing `id` (`null` at the top level), or undefined if absent. */
function parentOf(blocks: readonly Block[], id: string): string | null | undefined {
  if (blocks.some((b) => b.id === id)) return null;
  for (const block of walkBlocks(blocks)) {
    if (block.type === 'section' && block.children.some((c) => c.id === id)) return block.id;
  }
  return undefined;
}

function siblings(blocks: readonly Block[], parentId: string | null): readonly Block[] {
  if (parentId === null) return blocks;
  const parent = findBlock(blocks, parentId);
  if (!parent) throw new PatchFailure(`Il blocco "${parentId}" non esiste`);
  if (parent.type !== 'section') {
    throw new PatchFailure(`Il blocco "${parentId}" non è una sezione: non può contenere blocchi`);
  }
  return parent.children;
}

function withSiblings(
  blocks: Block[],
  parentId: string | null,
  update: (list: readonly Block[]) => Block[],
): Block[] {
  if (parentId === null) return update(blocks);
  return updateBlock(blocks, parentId, (section) =>
    section.type === 'section' ? { ...section, children: update(section.children) } : section,
  );
}

function insertAt(blocks: Block[], block: Block, position: Position): Block[] {
  const anchor = position.after ?? position.before;
  let parentId: string | null;
  let index: number;
  if (anchor !== undefined) {
    const parent = parentOf(blocks, anchor);
    if (parent === undefined) throw new PatchFailure(`Il blocco "${anchor}" non esiste`);
    parentId = parent;
    const list = siblings(blocks, parentId);
    index = list.findIndex((b) => b.id === anchor) + (position.after !== undefined ? 1 : 0);
  } else {
    parentId = position.parentId ?? null;
    const list = siblings(blocks, parentId);
    index = Math.min(position.index ?? list.length, list.length);
  }
  return withSiblings(blocks, parentId, (list) => [
    ...list.slice(0, index),
    block,
    ...list.slice(index),
  ]);
}

function requireBlock(blocks: readonly Block[], id: string): Block {
  const block = findBlock(blocks, id);
  if (!block) throw new PatchFailure(`Il blocco "${id}" non esiste`);
  return block;
}

/**
 * Applies block operations in order. The result is not validated against the block
 * schemas: saving it (e.g. with `saveDraft`) does that.
 */
export function applyBlockPatch(
  blocks: readonly Block[],
  operations: readonly BlockPatchOperation[],
): ParseResult<Block[]> {
  let current = blocks as Block[];
  const errors: ContentIssue[] = [];
  operations.forEach((operation, i) => {
    try {
      switch (operation.op) {
        case 'update': {
          const block = requireBlock(current, operation.id);
          const fields = { ...operation.fields };
          if ('id' in fields || 'type' in fields) {
            throw new PatchFailure("Non si possono cambiare l'id o il tipo di un blocco");
          }
          current = updateBlock(current, operation.id, () => ({ ...block, ...fields }) as Block);
          break;
        }
        case 'replace': {
          requireBlock(current, operation.id);
          const replacement = withIds(operation.block);
          current = updateBlock(current, operation.id, () => replacement);
          break;
        }
        case 'insert': {
          const block = withIds(operation.block);
          if (findBlock(current, block.id)) {
            throw new PatchFailure(`Esiste già un blocco con id "${block.id}"`);
          }
          current = insertAt(current, block, operation);
          break;
        }
        case 'remove':
          requireBlock(current, operation.id);
          current = removeBlock(current, operation.id);
          break;
        case 'move': {
          const block = requireBlock(current, operation.id);
          const target = operation.after ?? operation.before ?? operation.parentId;
          if (target === operation.id || (target && findBlock([block], target))) {
            throw new PatchFailure(
              `Non si può spostare il blocco "${operation.id}" dentro se stesso`,
            );
          }
          current = insertAt(removeBlock(current, operation.id), block, operation);
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof PatchFailure)) throw error;
      errors.push({ path: `operations[${i}]`, message: error.message });
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: current };
}
