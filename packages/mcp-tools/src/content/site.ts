/**
 * Tools for what surrounds the pages: publication, the shared layouts and menus, and assets
 * (E9.1, TECHNICAL §7.5).
 *
 * Each tool is a thin adapter. It turns what the model sent into a call to the services of
 * `@ai-cms/content`, which check the permissions and validate the content, and it answers with
 * what the agent needs to decide what to do next. Nothing here touches the database directly.
 */
import { ASSET_CONTENT_TYPES, blockSchema, type MenuItem } from '@ai-cms/content';
import { uploadAsset } from '@ai-cms/content/assets';
import {
  ensureLayout,
  ensureMenu,
  publish as publishNode,
  saveDraft,
} from '@ai-cms/content/service';
import { NODE_NAME_PATTERN } from '@ai-cms/tree';
import { z } from 'zod';
import { defineCmsTool } from '../registry.ts';
import { afterWrite, saveOptions, type ContentExtra } from './context.ts';

const NAME_ERROR = 'Il nome usa solo lettere minuscole, cifre, "-" e "_" (es. "header")';

/** Name of a node in `/site/layouts` or `/site/menus`, with the rule the tree enforces. */
const nodeNameInput = z
  .string()
  .min(1, 'Il nome è obbligatorio')
  .max(63, 'Il nome può essere lungo al massimo 63 caratteri')
  .regex(NODE_NAME_PATTERN, NAME_ERROR)
  .describe('Nome del nodo in minuscolo, senza spazi (es. "header", "footer", "main")');

/**
 * The blocks the model sends. The schema of `@ai-cms/content` is the authoritative one and is
 * reused on purpose: this is what the model reads as JSON Schema, so it has to describe the
 * blocks instead of hiding them behind `unknown`. The service validates and normalizes again
 * on save, and every block needs an `id` of its own, unique in the document, because the
 * other tools address the blocks by id.
 */
const blocksInput = z.array(blockSchema);

/**
 * A voice of a menu. `menuSchema` in `@ai-cms/content` is the authoritative one, but it is
 * built as a pipe and converts to an empty JSON Schema, so the three fields are declared here
 * to show the model the real shape.
 */
const menuItemInput: z.ZodType<MenuItem> = z.strictObject({
  label: z.string().min(1, "L'etichetta della voce è obbligatoria"),
  href: z.string().min(1, 'Il collegamento della voce è obbligatorio'),
  children: z.lazy(() => z.array(menuItemInput)).optional(),
});

/* -------------------------------------------------------------------------- publish */

const publishInput = z.object({
  path: z
    .string()
    .min(1, 'Indica il nodo da pubblicare')
    .describe('Path del nodo, es. "/site/pages/chi-siamo" oppure "/site/layouts/header"'),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Numero della versione da pubblicare; se omesso, prende l'ultima salvata"),
});

/**
 * Puts a saved version on the site: `p` on the node.
 *
 * Publishing is the action the user has to have authorized, so the description tells the agent
 * to save first, show what would change and publish only on an explicit confirmation.
 */
export const publishTool = defineCmsTool<typeof publishInput, ContentExtra>({
  name: 'publish',
  action: 'publish',
  description: [
    'Pubblica una versione già salvata, rendendola visibile sul sito pubblico.',
    '',
    "Usalo solo quando l'utente ha autorizzato la pubblicazione: prima di chiamarlo, salvare",
    'tutte le modifiche del turno, mostrargli cosa cambiare e chiedere conferma, perché',
    'pubblicare mette online il contenuto subito. Non pubblicare una bozza "per far vedere": i',
    'strumenti di lettura mostrano già le versioni non pubblicate.',
    '',
    'La versione viene renderizzata e controllata con le regole HTML del sito (E6.7): se ha',
    "errori gravi la pubblicazione viene rifiutata e l'errore torna qui con l'elenco delle",
    'violazioni da correggere. In quel caso correggi il contenuto e riprova.',
    '',
    'Se la risposta contiene `hookError` la versione è online ma la rigenerazione del sito è',
    "fallita: riferiscilo all'utente, il contenuto è comunque pubblicato.",
  ].join('\n'),
  input: publishInput,
  run: async ({ path, version }, ctx) => {
    const result = await publishNode(ctx.db, ctx.principal, ctx.env, path, {
      ...(version === undefined ? {} : { version }),
      onPublished: ctx.onPublished,
      validateRendered: ctx.validateRendered,
    });
    return {
      path: result.path,
      status: result.status,
      version: result.version,
      versionId: result.versionId,
      ...(result.hookError ? { hookError: result.hookError } : {}),
    };
  },
});

/* ------------------------------------------------------------------- update_layout */

const updateLayoutInput = z.object({
  name: nodeNameInput.describe('Nome del layout in /site/layouts: "header" o "footer"'),
  blocks: blocksInput.describe("Blocchi del layout, dall'inizio alla fine"),
  expectedVersion: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Numero dell'ultima versione che hai visto: se il nodo è cambiato nel frattempo la " +
        'scrittura viene rifiutata (concorrenza ottimistica, FR-64)',
    ),
});

/**
 * Writes the blocks of a shared layout: `w` on the node.
 *
 * There is no `saveLayout` in the services, so the node is created when missing and then
 * saved like any other content. The violations come back because a header or a footer ends up
 * in every page: one violation there is one violation everywhere.
 */
export const updateLayoutTool = defineCmsTool<typeof updateLayoutInput, ContentExtra>({
  name: 'update_layout',
  action: 'write',
  description: [
    'Scrive i blocchi di un layout condiviso del sito: l\'intestazione ("header") o il pie\' di',
    'pagina ("footer"), che il sito inserisce in ogni pagina.',
    '',
    "Usalo quando l'utente chiede di cambiare l'intestazione, il menu, il piè di pagina o",
    'qualsiasi elemento che si ripete su tutto il sito. Il nodo viene creato se non esiste',
    'ancora: non serve crearlo prima.',
    '',
    'La risposta contiene `violations`: sono gli errori HTML gravi del layout renderizzato.',
    'Metti sempre a posto i blocchi prima di pubblicare, perché header e footer finiscono in',
    'ogni pagina e un errore lì blocca la pubblicazione del sito intero. `warnings` sono solo',
    'suggerimenti e non impediscono la pubblicazione.',
  ].join('\n'),
  input: updateLayoutInput,
  run: async ({ name, blocks, expectedVersion }, ctx) => {
    const node = await ensureLayout(ctx.db, ctx.principal, ctx.env, name);
    const body = { blocks };
    const saved = await saveDraft(
      ctx.db,
      ctx.principal,
      ctx.env,
      node.path,
      body,
      saveOptions(ctx, expectedVersion),
    );
    return afterWrite(ctx, node.path, saved.body, saved.version);
  },
});

/* -------------------------------------------------------------------- update_menu */

const updateMenuInput = z.object({
  name: nodeNameInput.describe('Nome del menu in /site/menus, es. "main"'),
  items: z
    .array(menuItemInput)
    .describe(
      'Voci del menu, in ordine. Ogni voce è { label, href, children? }: `href` è il ' +
        'collegamento ("/", "/chi-siamo", "https://…") e `children` contiene le sotto-voci.',
    ),
  expectedVersion: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Numero dell'ultima versione che hai visto: se il nodo è cambiato nel frattempo la " +
        'scrittura viene rifiutata (concorrenza ottimistica, FR-64)',
    ),
});

/**
 * Writes the items of a shared menu: `w` on the node.
 *
 * A menu body is *not* a list of blocks: it is `{ items }`, and this is the part agents get
 * wrong, so the description spells the shape out with an example.
 */
export const updateMenuTool = defineCmsTool<typeof updateMenuInput, ContentExtra>({
  name: 'update_menu',
  action: 'write',
  description: [
    'Scrive le voci di un menu condiviso del sito (per esempio il menu principale "main"),',
    "usato dall'intestazione e dal piè di pagina.",
    '',
    'ATTENZIONE alla forma: un menu NON è una lista di blocchi. Il corpo del menu è',
    '{ "items": [...] } e ogni voce è { "label": "...", "href": "...", "children": [...] }, con',
    'al massimo 3 livelli di voci annidate. Esempio:',
    '{ "items": [ { "label": "Home", "href": "/" },',
    '             { "label": "Servizi", "href": "/servizi", "children": [',
    '               { "label": "Ristorazione", "href": "/servizi/ristorazione" } ] } ] }',
    '',
    'La voce non è un blocco: non ha `id`, `type` né `text`. I collegamenti sono gli stessi',
    'ammessi nelle pagine: interni ("/chi-siamo"), http(s), "mailto:" o "tel:".',
    '',
    'Il nodo viene creato se non esiste ancora. La risposta contiene `violations`: gli errori',
    'HTML gravi trovati nel menu, che renderebbero il sito non pubblicabile.',
  ].join('\n'),
  input: updateMenuInput,
  run: async ({ name, items, expectedVersion }, ctx) => {
    const node = await ensureMenu(ctx.db, ctx.principal, ctx.env, name);
    const body = { items };
    const saved = await saveDraft(
      ctx.db,
      ctx.principal,
      ctx.env,
      node.path,
      body,
      saveOptions(ctx, expectedVersion),
    );
    return afterWrite(ctx, node.path, saved.body, saved.version);
  },
});

/* ------------------------------------------------------------------ upload_asset */

const uploadAssetInput = z.object({
  filename: z
    .string()
    .min(1, 'Il nome del file è obbligatorio')
    .max(255, 'Il nome del file può essere lungo al massimo 255 caratteri')
    .describe('Nome originale del file, con estensione (es. "hero-home.png")'),
  contentType: z
    .enum(ASSET_CONTENT_TYPES)
    .describe(
      `Tipo del file. Ammessi solo: ${ASSET_CONTENT_TYPES.join(', ')}. Le immagini SVG non ` +
        'sono ammesse perché possono contenere script: usa PNG, WebP, AVIF, JPEG o GIF.',
    ),
  dataBase64: z
    .string()
    .min(1, 'Il file è obbligatorio')
    .describe(
      'Contenuto del file in base64, in un solo blocco e senza prefisso "data:" (leggere il ' +
        'file e codificarlo, non passare il percorso)',
    ),
  alt: z
    .string()
    .max(300, 'Il testo alternativo può essere lungo al massimo 300 caratteri')
    .optional()
    .describe(
      "Testo alternativo dell'immagine, per chi non la vede. Obbligatorio per le immagini se " +
        '`decorative` non è true',
    ),
  decorative: z
    .boolean()
    .optional()
    .describe("true se l'immagine è puramente decorativa: in questo caso `alt` non serve"),
  parent: z
    .string()
    .min(1)
    .optional()
    .describe('Cartella del file, es. "/site/assets/logo". Se omesso il file va in "/site/assets"'),
});

/**
 * Uploads a file as an asset node and returns its public URL: `c` on the parent folder.
 *
 * The service needs the storage, which only cms-api has, so it comes from the context.
 */
export const uploadAssetTool = defineCmsTool<typeof uploadAssetInput, ContentExtra>({
  name: 'upload_asset',
  action: 'create',
  description: [
    'Carica un file (immagine, PDF o video) nel sito e restituisce il suo URL pubblico.',
    '',
    "Usalo quando l'utente chiede di inserire un'immagine, un logo, una brochure o quando un",
    'testo da scrivere richiede un file. Il contenuto del file va inviato in base64.',
    '',
    'Tipi ammessi: immagini JPEG, PNG, WebP, AVIF e GIF, documenti PDF e video MP4. Le SVG non',
    'sono ammesse perché possono contenere script. Le immagini vengono ridimensionate',
    'automaticamente e servite in WebP.',
    '',
    "Per le immagini serve `alt` (il testo alternativo), a meno che l'immagine sia solo",
    'decorativa: in quel caso passa `decorative: true`. Se il file va dentro una pagina, usa',
    "l'URL restituito in un blocco immagine.",
  ].join('\n'),
  input: uploadAssetInput,
  run: async ({ filename, contentType, dataBase64, alt, decorative, parent }, ctx) => {
    const asset = await uploadAsset(
      ctx.db,
      ctx.storage,
      ctx.principal,
      ctx.env,
      parent,
      { filename, contentType, data: Buffer.from(dataBase64, 'base64'), alt, decorative },
      { viaAgent: ctx.principal.agent?.name ?? null, conversationId: ctx.conversationId },
    );
    return {
      path: asset.node.path,
      url: asset.url,
      version: asset.version.version,
      published: asset.published,
    };
  },
});

/** Site, asset and publication tools, as cms-api registers them. */
export const siteTools = [publishTool, updateLayoutTool, updateMenuTool, uploadAssetTool] as const;
