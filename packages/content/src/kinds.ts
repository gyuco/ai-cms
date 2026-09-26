import { parseAssetMeta } from './assets.ts';
import { parseMenu, parseSiteSettings, type ParseResult } from './documents.ts';
import { normalizeLayout, normalizePageBody } from './normalize.ts';

/** Node kinds whose content lives in `content_versions`, with the normalizer for each. */
const normalizers = {
  page: normalizePageBody,
  layout: normalizeLayout,
  menu: parseMenu,
  setting: parseSiteSettings,
  asset: parseAssetMeta,
} satisfies Record<string, (input: unknown) => ParseResult<unknown>>;

export type ContentKind = keyof typeof normalizers;

export const CONTENT_KINDS = Object.keys(normalizers) as ContentKind[];

export function isContentKind(kind: string): kind is ContentKind {
  return Object.hasOwn(normalizers, kind);
}

/**
 * Validates and normalizes a body for a node of the given kind: the one entry point
 * before saving a version.
 */
export function normalizeBodyForKind(kind: string, input: unknown): ParseResult<unknown> {
  if (!isContentKind(kind)) {
    return {
      ok: false,
      errors: [
        { path: '', message: `I nodi di tipo "${kind}" non hanno un contenuto modificabile` },
      ],
    };
  }
  return normalizers[kind](input);
}
