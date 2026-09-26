import { z } from 'zod';
import type { ParseResult } from './documents.ts';
import { formatPath } from './documents.ts';
import { LIMITS } from './limits.ts';

/** Accepted upload types. SVG is excluded on purpose: it can carry scripts. */
export const ASSET_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'application/pdf',
  'video/mp4',
] as const;

export type AssetContentType = (typeof ASSET_CONTENT_TYPES)[number];
export type AssetMediaType = 'image' | 'document' | 'video';

export function assetMediaType(contentType: AssetContentType): AssetMediaType {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType === 'video/mp4') return 'video';
  return 'document';
}

/** Widths of the resized image variants; images are never enlarged. */
export const IMAGE_VARIANT_WIDTHS = [480, 960, 1920] as const;

const dimension = z.number().int().positive().max(100_000);
const size = z.number().int().nonnegative();
const objectKey = z.string().min(1).max(512);

export const assetVariantSchema = z.strictObject({
  /** `optimized` (full size webp) or `w480`, `w960`, `w1920`. */
  name: z.string().regex(/^[a-z0-9-]{1,32}$/),
  key: objectKey,
  contentType: z.string().min(1).max(100),
  width: dimension,
  height: dimension,
  size,
});

export type AssetVariant = z.infer<typeof assetVariantSchema>;

/** Metadata of an asset node, stored as its content (the file itself is in S3). */
export const assetMetaSchema = z
  .strictObject({
    filename: z.string().trim().min(1, 'Il nome del file è obbligatorio').max(255),
    contentType: z.enum(ASSET_CONTENT_TYPES, 'Tipo di file non ammesso'),
    mediaType: z.enum(['image', 'document', 'video']),
    size,
    /** Object key of the original file in the environment's bucket. */
    key: objectKey,
    width: dimension.optional(),
    height: dimension.optional(),
    alt: z.string().trim().max(LIMITS.shortText),
    decorative: z.boolean().optional(),
    variants: z.array(assetVariantSchema).max(16),
  })
  .superRefine((meta, ctx) => {
    if (meta.mediaType === 'image' && !meta.decorative && meta.alt === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['alt'],
        message:
          "Il testo alternativo è obbligatorio, a meno che l'immagine sia marcata come decorativa",
      });
    }
  });

export type AssetMeta = z.infer<typeof assetMetaSchema>;

const italian = z.locales.it().localeError;

export function parseAssetMeta(input: unknown): ParseResult<AssetMeta> {
  const result = assetMetaSchema.safeParse(input, { error: italian });
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message })),
  };
}

/** Default public prefix under which the site serves assets (E6). */
export const ASSET_URL_BASE = '/_assets';

/** URL of an asset file, e.g. `/_assets/<id>/w960`. Without a variant: the original. */
export function getAssetUrl(id: string, variant?: string, base: string = ASSET_URL_BASE): string {
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base;
  return variant && variant !== 'original' ? `${prefix}/${id}/${variant}` : `${prefix}/${id}`;
}

/** `srcset` for the resized webp variants of an image, narrowest first. */
export function assetSrcSet(id: string, meta: AssetMeta, base?: string): string {
  return meta.variants
    .filter((v) => v.name.startsWith('w'))
    .sort((a, b) => a.width - b.width)
    .map((v) => `${getAssetUrl(id, v.name, base)} ${v.width}w`)
    .join(', ');
}

/** The requested variant, falling back to the optimized one, then to the original. */
export function pickAssetVariant(
  meta: AssetMeta,
  name: string | undefined,
): { key: string; contentType: string; size: number; name: string } {
  if (name && name !== 'original') {
    const variant =
      meta.variants.find((v) => v.name === name) ??
      meta.variants.find((v) => v.name === 'optimized');
    if (variant) return variant;
  }
  return { key: meta.key, contentType: meta.contentType, size: meta.size, name: 'original' };
}
