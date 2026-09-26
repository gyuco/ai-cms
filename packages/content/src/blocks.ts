import { z } from 'zod';
import { BLOCK_ID_PATTERN } from './ids.ts';
import { LIMITS } from './limits.ts';
import { isSafeHref, isSafeImageSrc } from './url.ts';

// Types are written by hand: `section` is recursive and inference cannot follow it.

/** A run of text with optional formatting and link. */
export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** http(s), mailto, tel or a root-relative path. */
  href?: string;
}

export interface ImageData {
  /** Asset id, absolute http(s) URL or root-relative path. */
  src: string;
  /** Required and non-empty unless `decorative` is true. */
  alt: string;
  decorative?: boolean;
  caption?: string;
  width?: number;
  height?: number;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
export type SectionTag = 'section' | 'article' | 'aside' | 'div';
export type ButtonVariant = 'primary' | 'secondary';

export interface HeadingBlock {
  id: string;
  type: 'heading';
  level: HeadingLevel;
  text: string;
}
export interface ParagraphBlock {
  id: string;
  type: 'paragraph';
  content: Inline[];
}
export interface ImageBlock extends ImageData {
  id: string;
  type: 'image';
}
export interface GalleryBlock {
  id: string;
  type: 'gallery';
  images: ImageData[];
}
export interface ListBlock {
  id: string;
  type: 'list';
  ordered: boolean;
  items: Inline[][];
}
export interface QuoteBlock {
  id: string;
  type: 'quote';
  content: Inline[];
  cite?: string;
}
export interface ButtonBlock {
  id: string;
  type: 'button';
  label: string;
  href: string;
  variant?: ButtonVariant;
}
export interface SectionBlock {
  id: string;
  type: 'section';
  tag: SectionTag;
  label?: string;
  children: Block[];
}
export interface HtmlBlock {
  id: string;
  type: 'html';
  /** Free HTML; sanitized when the document is normalized for saving. */
  html: string;
}

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ImageBlock
  | GalleryBlock
  | ListBlock
  | QuoteBlock
  | ButtonBlock
  | SectionBlock
  | HtmlBlock;

export type BlockType = Block['type'];

const HREF_ERROR =
  'Link non valido: sono ammessi solo http(s), mailto:, tel: o percorsi che iniziano con "/"';
const SRC_ERROR =
  'Sorgente dell\'immagine non valida: usa l\'id di un asset, un URL http(s) o un percorso che inizia con "/"';

const shortText = z.string().trim().min(1, 'Il testo non può essere vuoto').max(LIMITS.shortText);
export const hrefSchema = z.string().max(LIMITS.url).refine(isSafeHref, HREF_ERROR);
export const imageSrcSchema = z.string().max(LIMITS.url).refine(isSafeImageSrc, SRC_ERROR);
const blockId = z
  .string()
  .regex(BLOCK_ID_PATTERN, "L'id del blocco può contenere solo lettere, cifre, '-' e '_' (max 64)");

export const inlineSchema = z.strictObject({
  text: z.string().max(LIMITS.text),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  code: z.boolean().optional(),
  href: hrefSchema.optional(),
});

const inlines = z
  .array(inlineSchema)
  .min(1, 'Serve almeno un frammento di testo')
  .max(LIMITS.inlinesPerBlock);

const dimension = z.number().int().positive().max(20_000);

const imageFields = {
  src: imageSrcSchema,
  alt: z.string().trim().max(LIMITS.shortText),
  decorative: z.boolean().optional(),
  caption: z
    .string()
    .max(LIMITS.shortText * 4)
    .optional(),
  width: dimension.optional(),
  height: dimension.optional(),
};

function requireAlt(
  image: { alt: string; decorative?: boolean | undefined },
  ctx: z.RefinementCtx,
) {
  if (!image.decorative && image.alt === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['alt'],
      message:
        "Il testo alternativo è obbligatorio, a meno che l'immagine sia marcata come decorativa",
    });
  }
}

export const imageDataSchema = z.strictObject(imageFields).superRefine(requireAlt);

const headingSchema = z.strictObject({
  id: blockId,
  type: z.literal('heading'),
  level: z.literal([1, 2, 3, 4, 5, 6], 'Il livello del titolo deve essere tra 1 e 6'),
  text: shortText,
});
const paragraphSchema = z.strictObject({
  id: blockId,
  type: z.literal('paragraph'),
  content: inlines,
});
const imageSchema = z
  .strictObject({ id: blockId, type: z.literal('image'), ...imageFields })
  .superRefine(requireAlt);
const gallerySchema = z.strictObject({
  id: blockId,
  type: z.literal('gallery'),
  images: z
    .array(imageDataSchema)
    .min(1, "La galleria deve avere almeno un'immagine")
    .max(LIMITS.galleryImages),
});
const listSchema = z.strictObject({
  id: blockId,
  type: z.literal('list'),
  ordered: z.boolean(),
  items: z.array(inlines).min(1, 'La lista deve avere almeno un elemento').max(LIMITS.listItems),
});
const quoteSchema = z.strictObject({
  id: blockId,
  type: z.literal('quote'),
  content: inlines,
  cite: z.string().trim().min(1).max(LIMITS.shortText).optional(),
});
const buttonSchema = z.strictObject({
  id: blockId,
  type: z.literal('button'),
  label: shortText,
  href: hrefSchema,
  variant: z.enum(['primary', 'secondary']).optional(),
});
const sectionSchema = z.strictObject({
  id: blockId,
  type: z.literal('section'),
  tag: z.enum(['section', 'article', 'aside', 'div']),
  label: shortText.optional(),
  children: z.lazy(() => z.array(blockSchema).max(LIMITS.blocksPerList)),
});
const htmlSchema = z.strictObject({
  id: blockId,
  type: z.literal('html'),
  html: z.string().max(LIMITS.html),
});

/** A single block. Prefer `blocksSchema` for whole lists: it also checks depth, size and ids. */
export const blockSchema: z.ZodType<Block> = z.discriminatedUnion(
  'type',
  [
    headingSchema,
    paragraphSchema,
    imageSchema,
    gallerySchema,
    listSchema,
    quoteSchema,
    buttonSchema,
    sectionSchema,
    htmlSchema,
  ],
  { error: 'Tipo di blocco sconosciuto' },
);

/**
 * Nesting depth along `childKey`, computed on raw input without recursion so that
 * absurdly deep payloads are rejected before the recursive schema walks them.
 * Stops counting once `limit` is exceeded.
 */
export function rawDepth(value: unknown, childKey: string, limit: number): number {
  let max = 0;
  const stack: { list: unknown; depth: number }[] = [{ list: value, depth: 0 }];
  while (stack.length > 0) {
    const { list, depth } = stack.pop()!;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue;
      const children = (item as Record<string, unknown>)[childKey];
      if (!Array.isArray(children)) continue;
      max = Math.max(max, depth + 1);
      if (max > limit) return max;
      stack.push({ list: children, depth: depth + 1 });
    }
  }
  return max;
}

function checkBlockTree(blocks: Block[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  let count = 0;
  const visit = (list: Block[]) => {
    for (const block of list) {
      count++;
      if (seen.has(block.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `L'id di blocco "${block.id}" è usato più di una volta`,
        });
      }
      seen.add(block.id);
      if (block.type === 'section') visit(block.children);
    }
  };
  visit(blocks);
  if (count > LIMITS.blocks) {
    ctx.addIssue({
      code: 'custom',
      message: `Troppi blocchi: massimo ${LIMITS.blocks} per documento`,
    });
  }
}

/** A list of blocks with section depth, total size and unique ids checked. */
export const blocksSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (rawDepth(value, 'children', LIMITS.sectionDepth) > LIMITS.sectionDepth) {
      ctx.addIssue({
        code: 'custom',
        message: `Le sezioni sono annidate troppo: massimo ${LIMITS.sectionDepth} livelli`,
      });
    }
  })
  .pipe(z.array(blockSchema).max(LIMITS.blocksPerList).superRefine(checkBlockTree));
