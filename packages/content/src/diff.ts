import type { Block } from './blocks.ts';

export interface BlockPosition {
  /** Id of the containing section, `null` at the top level. */
  parentId: string | null;
  index: number;
}

export interface BlockRef extends BlockPosition {
  id: string;
  type: string;
}

export interface BlockModification {
  id: string;
  type: string;
  /** For sections, `children` is left out: child changes are reported on their own. */
  before: unknown;
  after: unknown;
}

export interface BlockMove {
  id: string;
  type: string;
  from: BlockPosition;
  to: BlockPosition;
}

export interface FieldChange {
  /** `meta.title` for page metadata, the top-level key otherwise (e.g. `name`, `items`). */
  field: string;
  before: unknown;
  after: unknown;
}

export interface BodyDiff {
  changed: boolean;
  blocks: {
    added: BlockRef[];
    removed: BlockRef[];
    modified: BlockModification[];
    moved: BlockMove[];
  };
  fields: FieldChange[];
}

/** JSON with sorted keys, so that key order does not count as a change. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

interface Located {
  block: Block;
  position: BlockPosition;
}

function blocksOf(body: unknown): Block[] {
  const blocks = (body as { blocks?: unknown } | null)?.blocks;
  return Array.isArray(blocks) ? (blocks as Block[]) : [];
}

function locate(blocks: readonly Block[]): Map<string, Located> {
  const out = new Map<string, Located>();
  const visit = (list: readonly Block[], parentId: string | null) => {
    list.forEach((block, index) => {
      out.set(block.id, { block, position: { parentId, index } });
      if (block.type === 'section') visit(block.children, block.id);
    });
  };
  visit(blocks, null);
  return out;
}

function withoutChildren(block: Block): unknown {
  if (block.type !== 'section') return block;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { children, ...rest } = block;
  return rest;
}

/** Ids of `sequence` that are not in a longest common subsequence with `other`. */
function outOfOrder(sequence: string[], other: string[]): Set<string> {
  const n = sequence.length;
  const m = other.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        sequence[i] === other[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const kept = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sequence[i] === other[j]) {
      kept.add(sequence[i]!);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return new Set(sequence.filter((id) => !kept.has(id)));
}

function diffFields(before: unknown, after: unknown): FieldChange[] {
  const record = (v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const a = record(before);
  const b = record(after);
  const changes: FieldChange[] = [];
  const compare = (prefix: string, x: Record<string, unknown>, y: Record<string, unknown>) => {
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
    for (const key of keys) {
      if (!same(x[key], y[key])) {
        changes.push({ field: prefix + key, before: x[key], after: y[key] });
      }
    }
  };
  const { blocks: _ab, meta: metaA, ...restA } = a;
  const { blocks: _bb, meta: metaB, ...restB } = b;
  void _ab;
  void _bb;
  if (metaA !== undefined || metaB !== undefined) compare('meta.', record(metaA), record(metaB));
  compare('', restA, restB);
  return changes;
}

/**
 * Block-level diff between two bodies (FR-61): blocks are matched by id, nested ones
 * included. Metadata and other top-level fields are compared key by key.
 */
export function diffBodies(before: unknown, after: unknown): BodyDiff {
  const a = locate(blocksOf(before));
  const b = locate(blocksOf(after));
  const ref = (id: string, { block, position }: Located): BlockRef => ({
    id,
    type: block.type,
    ...position,
  });

  const added = [...b].filter(([id]) => !a.has(id)).map(([id, l]) => ref(id, l));
  const removed = [...a].filter(([id]) => !b.has(id)).map(([id, l]) => ref(id, l));
  const modified: BlockModification[] = [];
  const moved: BlockMove[] = [];

  // Same parent: only blocks whose relative order changed count as moved.
  const common = (map: Map<string, Located>, other: Map<string, Located>) => {
    const byParent = new Map<string | null, string[]>();
    for (const [id, { position }] of map) {
      const target = other.get(id);
      if (!target || target.position.parentId !== position.parentId) continue;
      const list = byParent.get(position.parentId) ?? [];
      list[position.index] = id;
      byParent.set(position.parentId, list);
    }
    for (const [parent, list] of byParent) byParent.set(parent, list.filter(Boolean));
    return byParent;
  };
  const orderA = common(a, b);
  const orderB = common(b, a);
  const reordered = new Set<string>();
  for (const [parent, list] of orderA) {
    for (const id of outOfOrder(list, orderB.get(parent) ?? [])) reordered.add(id);
  }

  for (const [id, left] of a) {
    const right = b.get(id);
    if (!right) continue;
    const beforeBlock = withoutChildren(left.block);
    const afterBlock = withoutChildren(right.block);
    if (!same(beforeBlock, afterBlock)) {
      modified.push({ id, type: right.block.type, before: beforeBlock, after: afterBlock });
    }
    if (left.position.parentId !== right.position.parentId || reordered.has(id)) {
      moved.push({ id, type: right.block.type, from: left.position, to: right.position });
    }
  }

  const fields = diffFields(before, after);
  return {
    changed: added.length + removed.length + modified.length + moved.length + fields.length > 0,
    blocks: { added, removed, modified, moved },
    fields,
  };
}
