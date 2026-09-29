import type { Block } from './blocks.ts';
import {
  parseLayout,
  parsePageBody,
  type Layout,
  type PageBody,
  type ContentIssue,
  type ParseResult,
} from './documents.ts';
import { describeRemovals, sanitizeHtml } from './sanitize.ts';
import { mapBlocks, walkBlocks } from './traverse.ts';

/** Sanitizes every `html` block, nested ones included. */
export function sanitizeBlocks(blocks: readonly Block[]): Block[] {
  return mapBlocks(blocks, (block) => {
    if (block.type !== 'html') return block;
    const html = sanitizeHtml(block.html);
    return html === block.html ? block : { ...block, html };
  });
}

const CSS_HINT =
  "Il CSS non va nei blocchi HTML: chiedi all'agente sviluppatore di aggiungerlo a un file CSS del sito (staging → Approva e pubblica).";

/**
 * `html` blocks that the sanitizer would silently strip of styles, scripts, handlers or of
 * everything they contain. Saving them would look like a success while losing the content.
 */
function rejectedHtmlBlocks(blocks: readonly Block[]): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (const block of walkBlocks(blocks)) {
    if (block.type !== 'html') continue;
    const removed = describeRemovals(block.html);
    if (removed.length === 0) continue;
    issues.push({
      path: `blocco "${block.id}"`,
      message: `il blocco html contiene ${removed.join(', ')}, che il sito rimuove per sicurezza. ${CSS_HINT}`,
    });
  }
  return issues;
}

/** Parse + sanitize: the only way a page body should be prepared for saving. */
export function normalizePageBody(input: unknown): ParseResult<PageBody> {
  const result = parsePageBody(input);
  if (!result.ok) return result;
  const rejected = rejectedHtmlBlocks(result.value.blocks);
  if (rejected.length > 0) return { ok: false, errors: rejected };
  return { ok: true, value: { ...result.value, blocks: sanitizeBlocks(result.value.blocks) } };
}

/** Parse + sanitize for shared header and footer layouts. */
export function normalizeLayout(input: unknown): ParseResult<Layout> {
  const result = parseLayout(input);
  if (!result.ok) return result;
  const rejected = rejectedHtmlBlocks(result.value.blocks);
  if (rejected.length > 0) return { ok: false, errors: rejected };
  return { ok: true, value: { blocks: sanitizeBlocks(result.value.blocks) } };
}
