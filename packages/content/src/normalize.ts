import type { Block } from './blocks.ts';
import {
  parseLayout,
  parsePageBody,
  type Layout,
  type PageBody,
  type ParseResult,
} from './documents.ts';
import { sanitizeHtml } from './sanitize.ts';
import { mapBlocks } from './traverse.ts';

/** Sanitizes every `html` block, nested ones included. */
export function sanitizeBlocks(blocks: readonly Block[]): Block[] {
  return mapBlocks(blocks, (block) => {
    if (block.type !== 'html') return block;
    const html = sanitizeHtml(block.html);
    return html === block.html ? block : { ...block, html };
  });
}

/** Parse + sanitize: the only way a page body should be prepared for saving. */
export function normalizePageBody(input: unknown): ParseResult<PageBody> {
  const result = parsePageBody(input);
  if (!result.ok) return result;
  return { ok: true, value: { ...result.value, blocks: sanitizeBlocks(result.value.blocks) } };
}

/** Parse + sanitize for shared header and footer layouts. */
export function normalizeLayout(input: unknown): ParseResult<Layout> {
  const result = parseLayout(input);
  if (!result.ok) return result;
  return { ok: true, value: { blocks: sanitizeBlocks(result.value.blocks) } };
}
