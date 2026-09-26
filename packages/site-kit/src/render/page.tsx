import {
  outline,
  type Block,
  type Layout,
  type OutlineEntry,
  type PageBody,
} from '@ai-cms/content';
import { FOOTER_NODE, HEADER_NODE, treePath } from '../paths.ts';
import { Blocks } from './blocks.tsx';
import type { RenderOptions } from './options.ts';

export interface PageViewProps {
  page: PageBody;
  /** ltree path of the page node, e.g. `site.pages.chi-siamo`. */
  nodePath: string;
  header?: Layout | null;
  footer?: Layout | null;
  /** CSP nonce, for the JSON-LD data block. */
  nonce?: string;
  options?: RenderOptions;
}

/** Serializes JSON-LD so that it cannot close the <script> element it lives in. */
export function jsonLdText(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

/**
 * The body of a content page: shared header, `<main>` with the page blocks, shared footer.
 * Each container carries `data-cms-node` with the tree path it comes from (FR-146).
 */
export function PageView({ page, nodePath, header, footer, nonce, options }: PageViewProps) {
  return (
    <>
      {header && header.blocks.length > 0 ? (
        <header data-cms-node={treePath(HEADER_NODE)}>
          <Blocks blocks={header.blocks} options={options} />
        </header>
      ) : null}
      <main data-cms-node={treePath(nodePath)}>
        <Blocks blocks={page.blocks} options={options} />
      </main>
      {footer && footer.blocks.length > 0 ? (
        <footer data-cms-node={treePath(FOOTER_NODE)}>
          <Blocks blocks={footer.blocks} options={options} />
        </footer>
      ) : null}
      {page.meta.jsonLd !== undefined ? (
        <script
          type="application/ld+json"
          nonce={nonce}
          // Structured data, not HTML: JSON with every character that could end the element escaped.
          dangerouslySetInnerHTML={{ __html: jsonLdText(page.meta.jsonLd) }}
        />
      ) : null}
    </>
  );
}

/** Heading structure of a rendered page, shared header and footer included (TECHNICAL §11.3). */
export function pageOutline(
  page: { blocks: readonly Block[] },
  header?: Layout | null,
  footer?: Layout | null,
): OutlineEntry[] {
  return outline([...(header?.blocks ?? []), ...page.blocks, ...(footer?.blocks ?? [])]);
}
