import { z } from 'zod';
import { blocksSchema, imageSrcSchema, hrefSchema, rawDepth, type Block } from './blocks.ts';
import { LIMITS } from './limits.ts';
import { isHttpUrl, isRootRelative } from './url.ts';

const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const ROBOTS_TOKEN = '(all|none|index|noindex|follow|nofollow|noarchive|nosnippet|noimageindex)';
const ROBOTS = new RegExp(`^${ROBOTS_TOKEN}(\\s*,\\s*${ROBOTS_TOKEN})*$`);

export const langSchema = z.string().regex(LANG, 'Codice lingua non valido (es. "it" o "it-IT")');

const optionalText = (max: number) =>
  z.string().trim().min(1, 'Il testo non può essere vuoto').max(max).optional();

export const pageMetaSchema = z.strictObject({
  title: optionalText(LIMITS.shortText),
  description: optionalText(LIMITS.shortText * 4),
  lang: langSchema.optional(),
  canonical: z
    .string()
    .max(LIMITS.url)
    .refine(
      (v) => isHttpUrl(v) || isRootRelative(v),
      'URL canonico non valido: usa un URL http(s) o un percorso che inizia con "/"',
    )
    .optional(),
  robots: z
    .string()
    .regex(ROBOTS, 'Valore di robots non valido (es. "index,follow" o "noindex,nofollow")')
    .optional(),
  og: z
    .strictObject({
      title: optionalText(LIMITS.shortText),
      description: optionalText(LIMITS.shortText * 4),
      image: imageSrcSchema.optional(),
    })
    .optional(),
  jsonLd: z
    .unknown()
    .refine((v) => {
      if (v === undefined) return true;
      try {
        const json = JSON.stringify(v);
        return (
          json !== undefined && json.length <= LIMITS.jsonLd && typeof v === 'object' && v !== null
        );
      } catch {
        return false;
      }
    }, `I dati strutturati devono essere un oggetto o un array JSON di al massimo ${LIMITS.jsonLd} caratteri`)
    .optional(),
});

export type PageMeta = z.infer<typeof pageMetaSchema>;

export const pageBodySchema = z.strictObject({
  meta: pageMetaSchema,
  blocks: blocksSchema,
});

export interface PageBody {
  meta: PageMeta;
  blocks: Block[];
}

export const siteSettingsSchema = z.strictObject({
  name: z.string().trim().min(1, 'Il nome del sito è obbligatorio').max(LIMITS.shortText),
  lang: langSchema,
  titleTemplate: z
    .string()
    .max(LIMITS.shortText)
    .refine(
      (v) => v.includes('%s'),
      'Il modello del titolo deve contenere "%s" (es. "%s · Nome sito")',
    ),
  favicon: imageSrcSchema.optional(),
  socialImage: imageSrcSchema.optional(),
});

export type SiteSettings = z.infer<typeof siteSettingsSchema>;

/** Shared header or footer (`/site/layouts`). */
export const layoutSchema = z.strictObject({ blocks: blocksSchema });

export interface Layout {
  blocks: Block[];
}

export interface MenuItem {
  label: string;
  href: string;
  children?: MenuItem[];
}

const menuItemSchema: z.ZodType<MenuItem> = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1, "L'etichetta della voce di menu è obbligatoria")
    .max(LIMITS.shortText),
  href: hrefSchema,
  children: z.lazy(() => z.array(menuItemSchema).max(LIMITS.menuItems)).optional(),
});

export const menuSchema = z.strictObject({
  items: z
    .unknown()
    .superRefine((value, ctx) => {
      // Top-level items are level 1, so their `children` arrays start at depth 1.
      if (rawDepth(value, 'children', LIMITS.menuDepth - 1) > LIMITS.menuDepth - 1) {
        ctx.addIssue({
          code: 'custom',
          message: `Il menu può avere al massimo ${LIMITS.menuDepth} livelli`,
        });
      }
    })
    .pipe(z.array(menuItemSchema).max(LIMITS.menuItems)),
});

export interface Menu {
  items: MenuItem[];
}

/** A validation problem, with a readable path such as `blocks[2].content[0].href`. */
export interface ContentIssue {
  path: string;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: ContentIssue[] };

const italian = z.locales.it().localeError;

export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += (out === '' ? '' : '.') + String(segment);
  }
  return out;
}

function parseWith<T>(schema: z.ZodType<T, unknown>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input, { error: italian });
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: formatPath(issue.path),
      message: issue.message,
    })),
  };
}

export const parsePageBody = (input: unknown): ParseResult<PageBody> =>
  parseWith(pageBodySchema, input);
export const parseSiteSettings = (input: unknown): ParseResult<SiteSettings> =>
  parseWith(siteSettingsSchema, input);
export const parseLayout = (input: unknown): ParseResult<Layout> => parseWith(layoutSchema, input);
export const parseMenu = (input: unknown): ParseResult<Menu> => parseWith(menuSchema, input);

/** Human-readable summary of parse errors, one per line. */
export function formatIssues(errors: readonly ContentIssue[]): string {
  return errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('\n');
}
