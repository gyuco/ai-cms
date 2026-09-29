/**
 * The write tools on pages and nodes (E9.1, TECHNICAL §7.5): create a page, edit its blocks and
 * its metadata, move a node, delete it.
 *
 * Like the read tools, these are thin adapters: they turn what the model sent into a call to the
 * services of `@ai-cms/content` and `@ai-cms/tree`, which resolve the path, check the permission
 * (FR-132) and audit the denials. Nothing here touches the database, and no permission is checked
 * twice in the tool: the `action` each tool declares is what it *needs*, and the service is the
 * one that says no.
 *
 * Two rules shape the answers:
 *
 * - every tool that writes the content of a page answers with the HTML violations of what it
 *   just wrote (`afterWrite`), so the agent never proposes a page the site would refuse
 *   (TECHNICAL §11). The tree tools answer with the tree instead, which is what they change;
 * - the write that depends on what was read before carries `expectedVersion` (FR-64): the agent
 *   passes the version it worked on, and if somebody else wrote in the meantime the call fails
 *   with a conflict instead of overwriting their work.
 */
import {
  applyBlockPatch,
  blockPatchOperationSchema,
  blockSchema,
  formatIssues,
  pageMetaSchema,
  type Block,
} from '@ai-cms/content';
import { createPage, getContent, saveDraft, savePageMeta } from '@ai-cms/content/service';
import { ValidationError, deleteNode, moveNode } from '@ai-cms/tree';
import { z } from 'zod';
import { defineCmsTool } from '../registry.ts';
import { afterWrite, saveOptions, type ContentExtra, type WriteResult } from './context.ts';

/** Public path of a node, the form the agent reads everywhere (`/site/pages/chi-siamo`). */
const pathInput = z
  .string()
  .trim()
  .min(1, 'Indica il percorso del nodo, per esempio "/site/pages/chi-siamo".')
  .describe('Percorso del nodo, per esempio "/site/pages/chi-siamo".');

/**
 * The content version the agent is writing on top of. Optional: without it the write still lands
 * on the latest version, but the agent gets no protection against a concurrent write.
 */
const contentVersionInput = z
  .number()
  .int()
  .nonnegative('La versione è un numero intero non negativo')
  .optional()
  .describe(
    "Numero dell'ultima versione di contenuto che hai letto: se qualcun altro ha scritto nel " +
      'frattempo la scrittura viene rifiutata con un conflitto, invece di sovrascrivere il suo ' +
      'lavoro (concorrenza ottimistica, FR-64)',
  );

/** The tree version, for the operations on the node itself (rename, move, delete). */
const treeVersionInput = z
  .number()
  .int()
  .nonnegative('La versione è un numero intero non negativo')
  .optional()
  .describe(
    'Numero di versione del nodo che hai letto (quello restituito da read_node o da move_node): ' +
      "se il nodo è cambiato nel frattempo l'operazione viene rifiutata con un conflitto",
  );

/**
 * The blocks the model sends. The schema of `@ai-cms/content` is the authoritative one and is
 * reused on purpose: it is what the model reads as JSON Schema, so it has to describe the blocks
 * instead of hiding them behind `unknown`. Every block needs an `id` of its own, unique in the
 * page, because the other tools address the blocks by id.
 */
const blocksInput = z.array(blockSchema);

/* -------------------------------------------------------------------------- create_page */

const createPageInput = z.object({
  parent: z
    .string()
    .trim()
    .min(1, 'Indica la cartella in cui creare la pagina')
    .describe(
      'Cartella che conterrà la pagina, quasi sempre "/site/pages" (le pagine si creano solo ' +
        "là dentro o dentro un'altra pagina)",
    ),
  name: z
    .string()
    .trim()
    .min(1, 'Il nome della pagina è obbligatorio')
    .describe(
      'Nome del nodo in minuscolo, senza spazi né slash (es. "chi-siamo"): è l\'ultima parte ' +
        "dell'URL della pagina",
    ),
  title: z
    .string()
    .trim()
    .min(1, 'Il titolo non può essere vuoto')
    .optional()
    .describe("Titolo della pagina: finisce nell'intestazione del browser e nel menu"),
  blocks: blocksInput
    .optional()
    .describe("Blocchi iniziali della pagina, dall'inizio alla fine (omissione: pagina vuota)"),
  description: z
    .string()
    .trim()
    .min(1, 'La descrizione non può essere vuota')
    .optional()
    .describe(
      'Descrizione della pagina per i motori di ricerca: due frasi su cosa offre, non sul sito',
    ),
  expectedVersion: contentVersionInput.describe(
    'Versione di contenuto attesa quando vengono scritti i blocchi iniziali: `create_page` crea ' +
      'sempre la versione 1 (la bozza vuota), quindi di norma è 1',
  ),
});

/**
 * Creates a page and writes its first content: `c` on the parent folder.
 *
 * `createPage` already creates the node with an empty first version, so when there is something
 * to write the draft is saved right after: the agent does not have to make two calls to leave a
 * page that is not blank. The content lands on the version after the empty one, and the answer
 * carries the violations of the page as it was just written.
 */
export const createPageTool = defineCmsTool<typeof createPageInput, ContentExtra>({
  name: 'create_page',
  action: 'create',
  description: [
    'Crea una pagina nuova e ci scrive subito i contenuti iniziali.',
    '',
    "Usalo quando l'utente chiede una pagina che non esiste ancora, non per modificare una",
    'pagina esistente: per quella ci sono update_blocks (il testo) e update_meta (titolo e SEO).',
    '',
    "Il `name` è l'ultima parte dell'URL: minuscolo, senza spazi né slash, e cambia l'URL della",
    'pagina, quindi sceglilo con cura (es. "chi-siamo" → "/chi-siamo"). Le pagine si creano solo',
    "dentro /site/pages o dentro un'altra pagina.",
    '',
    'Il nodo nasce con una bozza vuota; se passi `blocks` o `description` il testo viene salvato',
    'in quella bozza come nuova versione. Ogni blocco ha bisogno di un `id` proprio e unico nella',
    "pagina, perché gli altri strumenti indicano i blocchi proprio con l'id.",
    '',
    'La risposta contiene `violations`: sono gli errori HTML gravi trovati nella pagina appena',
    'scritta. Se non sono vuoti, correggi i blocchi prima di pubblicare, altrimenti la',
    'pubblicazione verrà rifiutata. `warnings` sono solo suggerimenti.',
  ].join('\n'),
  input: createPageInput,
  run: async ({ parent, name, title, blocks, description, expectedVersion }, ctx) => {
    const created = await createPage(ctx.db, ctx.principal, ctx.env, parent, { name, title });
    let version = created.version;
    if (blocks !== undefined || description !== undefined) {
      // `createPage` filled the meta with the title, if any: the description is added to it and
      // the blocks land together, so the page is written in a single new version.
      const { meta } = created.version.body as { meta?: Record<string, unknown> };
      version = await saveDraft(
        ctx.db,
        ctx.principal,
        ctx.env,
        created.node.path,
        {
          meta: { ...meta, ...(description === undefined ? {} : { description }) },
          blocks: blocks ?? [],
        },
        saveOptions(ctx, expectedVersion),
      );
    }
    return {
      ...(await afterWrite(ctx, created.node.path, version.body, version.version)),
      url: created.url,
    };
  },
});

/* ------------------------------------------------------------------------ update_blocks */

const updateBlocksInput = z.object({
  path: pathInput,
  operations: z
    .array(blockPatchOperationSchema)
    .min(1, 'Serve almeno una operazione sui blocchi')
    .max(500, 'Massimo 500 operazioni per chiamata: raggruppa le modifiche')
    .describe(
      'Operazioni da applicare in ordine. "update" fonde campi in un blocco esistente (id e ' +
        'type non cambiano), "replace" sostituisce un blocco, "insert" aggiunge un blocco, ' +
        '"remove" lo toglie, "move" lo sposta. Per "insert" e "move" la posizione si dà con ' +
        '"after" o "before" (accanto a un blocco) oppure con "parentId" e "index" (dentro una ' +
        'sezione, index 0 = primo).',
    ),
  expectedVersion: contentVersionInput,
});

/**
 * Applies block operations to a page and saves the result: `w` on the node.
 *
 * The flow is the one of the plans (FR-63), one step at a time: read the latest version, apply
 * the patch, save the new body. The optimistic lock is not optional here: the patch is computed
 * on the version that was read, so a `saveDraft` without `expectedVersion` could silently
 * overwrite a block somebody else changed while the agent was thinking. Without an explicit
 * `expectedVersion` the version just read is the one expected.
 */
export const updateBlocksTool = defineCmsTool<typeof updateBlocksInput, ContentExtra>({
  name: 'update_blocks',
  action: 'write',
  description: [
    'Modifica i blocchi di una pagina esistente, salvando il risultato come nuova versione.',
    '',
    'È lo strumento giusto per cambiare il testo di una pagina senza riscriverla tutta: le',
    'operazioni sono piccole e indicano ogni blocco per `id`, quindi gli altri blocchi restano',
    "come sono. Per il titolo e i metadati SEO c'è update_meta; per i layout e i menu del sito",
    'ci sono update_layout e update_menu.',
    '',
    'Prima leggi la pagina con read_node, così usi gli `id` reali dei blocchi: un `id` che non',
    'esiste fa fallire tutta la chiamata senza scrivere niente, e lo stesso vale per uno spostamento',
    'di un blocco dentro se stesso. Se una sola operazione non è applicabile la pagina non viene',
    "toccata e l'errore dice quale.",
    '',
    'La risposta contiene `violations`: gli errori HTML gravi della pagina dopo la modifica.',
    'Se non sono vuoti, correggi prima di pubblicare. `warnings` sono solo suggerimenti.',
  ].join('\n'),
  input: updateBlocksInput,
  run: async ({ path, operations, expectedVersion }, ctx): Promise<WriteResult> => {
    // `latest` throws when the page has no content yet: there would be no blocks to patch.
    const snapshot = await getContent(ctx.db, ctx.principal, ctx.env, path, { version: 'latest' });
    const body = (snapshot.body ?? {}) as { meta?: unknown; blocks?: Block[] };
    const patched = applyBlockPatch(body.blocks ?? [], operations);
    if (!patched.ok) {
      throw new ValidationError(
        `Le operazioni sui blocchi di ${path} non sono applicabili:\n${formatIssues(patched.errors)}`,
      );
    }
    const saved = await saveDraft(
      ctx.db,
      ctx.principal,
      ctx.env,
      path,
      { ...body, blocks: patched.value },
      // The patch was computed on the version that was just read: that is the expected one.
      saveOptions(ctx, expectedVersion ?? snapshot.version),
    );
    return afterWrite(ctx, path, saved.body, saved.version);
  },
});

/* ------------------------------------------------------------------------- update_meta */

const updateMetaInput = z.object({
  path: pathInput,
  meta: pageMetaSchema.describe(
    'Metadati della pagina: title, description, lang, canonical, robots, og, jsonLd. Vedi ' +
      'update_meta: sostituiscono tutti i metadati precedenti.',
  ),
  expectedVersion: contentVersionInput,
});

/**
 * Replaces the metadata of a page, keeping its blocks: `w` on the node.
 *
 * Unlike the `updateMeta` of the plans, which merges key by key, this calls `savePageMeta`: the
 * agent sends the metadata it wants, and a key it does not send is gone. That is the safer
 * default for a model (it cannot leave a stale title behind) but it has to be said out loud, or
 * the agent keeps adding one field at a time and empties the page.
 */
export const updateMetaTool = defineCmsTool<typeof updateMetaInput, ContentExtra>({
  name: 'update_meta',
  action: 'write',
  description: [
    'Cambia i metadati di una pagina: titolo, descrizione, lingua, URL canonico, robots, anteprima',
    'social (og) e dati strutturati (jsonLd). I blocchi del testo restano come sono.',
    '',
    "Usalo per il titolo e la SEO, non per il testo della pagina: per i blocchi c'è update_blocks.",
    'Prima leggi la pagina con read_node, così parti dai metadati che ha già.',
    '',
    'ATTENZIONE: `meta` SOSTITUISCE tutti i metadati precedenti, non li completa. Un campo che',
    'ometti viene perso: se vuoi cambiare solo la descrizione, manda anche il titolo, la lingua e',
    'tutto il resto che deve restare. Per cancellare un campo basta non mandarlo.',
    '',
    'La risposta contiene `violations`: gli errori HTML gravi della pagina, che i metadati possono',
    'influenzare. `warnings` sono solo suggerimenti.',
  ].join('\n'),
  input: updateMetaInput,
  run: async ({ path, meta, expectedVersion }, ctx): Promise<WriteResult> => {
    const saved = await savePageMeta(
      ctx.db,
      ctx.principal,
      ctx.env,
      path,
      meta,
      saveOptions(ctx, expectedVersion),
    );
    return afterWrite(ctx, path, saved.body, saved.version);
  },
});

/* --------------------------------------------------------------------------- move_node */

const moveNodeInput = z.object({
  path: pathInput,
  newParent: z
    .string()
    .trim()
    .min(1, 'Indica la cartella di destinazione')
    .describe(
      'Cartella in cui spostare il nodo, per esempio "/site/pages/blog". Se è una pagina, ' +
        'tutti gli URL dentro cambiano.',
    ),
  name: z
    .string()
    .trim()
    .min(1, 'Il nome non può essere vuoto')
    .optional()
    .describe(
      'Nuovo nome in destinazione: rinomina il nodo mentre lo sposti. Se omesso, il nome resta ' +
        'quello attuale.',
    ),
  expectedVersion: treeVersionInput,
});

/**
 * Moves a node under another parent, renaming it there: `d` on the node and `c` on the new
 * parent, both checked by `moveNode`.
 *
 * The generic tree function and not `movePage`: the tool works on any node, and a folder of
 * pages, a layout or a file move exactly like a page. The answer is the tree, not the content,
 * because what changed is the path: `version` is the new tree version, to be passed as
 * `expectedVersion` to a later operation on the same node.
 */
export const moveNodeTool = defineCmsTool<typeof moveNodeInput, ContentExtra>({
  name: 'move_node',
  action: 'delete',
  description: [
    'Sposta un nodo (pagina, cartella, layout…) sotto un altro genitore, e con `name` lo rinomina',
    'in destinazione.',
    '',
    "Usalo quando l'utente chiede di riorganizzare il sito: spostare una pagina in un'altra",
    "cartella, accorparne alcune, cambiarne il nome. Spostare una pagina ne cambia l'URL, e",
    "cambiano anche gli URL delle pagine dentro: se il sito è già online, avvisi l'utente.",
    '',
    'Chiede il permesso di eliminazione sul nodo e di creazione sulla destinazione. Un nodo non',
    'può essere spostato dentro se stesso né nella sua stessa cartella con lo stesso nome, e i nodi',
    'della struttura di base del sito non si spostano.',
    '',
    "La risposta contiene il nuovo `path` e la `version` dell'albero, da usare come",
    '`expectedVersion` nelle operazioni successive sullo stesso nodo.',
  ].join('\n'),
  input: moveNodeInput,
  run: async ({ path, newParent, name, expectedVersion }, ctx) => {
    const node = await moveNode(ctx.db, ctx.principal, ctx.env, path, newParent, {
      ...(name === undefined ? {} : { name }),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
    return { path: node.path, version: node.version };
  },
});

/* -------------------------------------------------------------------------- delete_node */

const deleteNodeInput = z.object({
  path: pathInput,
  confirm: z
    .literal(
      true,
      "Operazione distruttiva: chiedi prima all'utente se vuole davvero eliminare il nodo, poi " +
        'richiama lo strumento con confirm: true.',
    )
    .describe(
      "Conferma esplicita dell'utente: senza, lo strumento non cancella nulla (FR-06). Mettila " +
        "true solo dopo aver chiesto conferma all'utente e averla ricevuta.",
    ),
  expectedVersion: treeVersionInput,
});

/**
 * Deletes a node and everything inside it, with its whole subtree: `d` on the node.
 *
 * It is a soft delete: the node leaves the tree but can be restored, versions included. The
 * confirmation is the point of the tool: FR-06 wants the user to know what is going away, so
 * `confirm` is in the schema (the registry refuses the call without it) and it is checked again
 * inside `run`, which stops before the service when a caller skips the validation. The registry
 * never lets a call reach `run` with a `confirm` that is not `true`, so the check is what
 * protects the other callers: the native agent loop and the tests.
 */
export const deleteNodeTool = defineCmsTool<typeof deleteNodeInput, ContentExtra>({
  name: 'delete_node',
  action: 'delete',
  description: [
    'Elimina un nodo e tutto ciò che contiene (le pagine dentro, i file, le versioni).',
    '',
    "Usalo solo quando l'utente chiede di cancellare una pagina, una cartella o un file. È",
    "un'operazione distruttiva: chiedi all'utente conferma spiegandogli cosa sparisce (anche i",
    'figli, se è una cartella) e solo dopo richiama lo strumento con `confirm: true`. Senza',
    'conferma lo strumento non cancella niente e te lo chiede.',
    '',
    'È un cancellino, non una cancellazione definitiva: la pagina esce dal sito ma si può',
    'ripristinare, con le sue versioni. I nodi della struttura di base del sito (per esempio',
    '/site) non si possono eliminare.',
  ].join('\n'),
  input: deleteNodeInput,
  run: async ({ path, confirm, expectedVersion }, ctx) => {
    if (confirm !== true) {
      throw new Error(
        `Eliminare ${path} è distruttivo: chiedi prima all'utente la conferma di cancellarlo e ` +
          'poi richiama lo strumento con confirm: true.',
      );
    }
    const node = await deleteNode(
      ctx.db,
      ctx.principal,
      ctx.env,
      path,
      expectedVersion === undefined ? {} : { expectedVersion },
    );
    return { path: node.path, deleted: true as const };
  },
});

/** Page and node write tools, as cms-api registers them. */
export const pageTools = [
  createPageTool,
  updateBlocksTool,
  updateMetaTool,
  moveNodeTool,
  deleteNodeTool,
] as const;
