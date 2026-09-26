/**
 * The first two content tools (E9.1, TECHNICAL §7.5): walking the tree and reading what is
 * inside a node.
 *
 * Both tools delegate to the services of `@ai-cms/content`, which resolve the path, check
 * the permission (`list` on the folder, `read` on the node) and audit the denials: the tools
 * themselves never touch the database, they only reshape what the services answer into
 * something an agent can read in one go.
 *
 * `title` exists only for pages: it is the `meta.title` of the latest version, so it is null
 * for folders, files and settings, and also for a page nobody has written yet. `url` has the
 * same rule, since only pages have one. The `status` object instead always tells what the node
 * has saved (`latestVersion`), what is online (`publishedVersion`) and whether the two differ
 * (`hasDraft`), which is what the agent needs before it proposes a change.
 */
import { getContent, listTreeEntries, listVersions } from '@ai-cms/content/service';
import { z } from 'zod';
import { defineCmsTool } from '../registry.ts';
import type { ContentTool } from './context.ts';

/** Public path of a node or folder (`/`, `/site/pages/blog`); the ltree form works too. */
const pathInput = z
  .string()
  .trim()
  .min(1, 'Indica il percorso del nodo, per esempio "/site/pages".')
  .describe('Percorso del nodo o della cartella, per esempio "/site/pages".');

/**
 * Schema of the service's `VersionRef`: a number, `latest` or `published`. Passing it to
 * `getContent` as it is keeps the two in step, default included.
 */
const versionInput = z
  .union([z.number().int().positive(), z.literal('latest'), z.literal('published')])
  .describe(
    'Versione da leggere: un numero, "latest" per l’ultima salvata (predefinito) o "published" per quella online.',
  );

const listNodesInput = z.object({ path: pathInput });

export const listNodesTool: ContentTool<typeof listNodesInput> = defineCmsTool({
  name: 'list_nodes',
  action: 'list',
  description:
    'Elenca i figli diretti di una cartella del sito, con percorso, tipo, URL, titolo e stato di pubblicazione. Usalo per orientarti: per capire cosa esiste già, quale pagina ha una bozza e quale versione è online prima di leggere o modificare qualcosa.',
  input: listNodesInput,
  run: async ({ path }, { db, principal, env }) => {
    const entries = await listTreeEntries(db, principal, env, path);
    // `version` (the tree version, for rename/move/delete) stays with the write tools.
    return entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      url: entry.url,
      title: entry.title,
      hasChildren: entry.hasChildren,
      status: entry.status,
    }));
  },
});

const readNodeInput = z.object({ path: pathInput, version: versionInput.optional() });

export const readNodeTool: ContentTool<typeof readNodeInput> = defineCmsTool({
  name: 'read_node',
  action: 'read',
  description:
    'Legge il contenuto di un nodo: metadati e blocchi della versione scelta, più l’elenco delle versioni con data, autore e stato di pubblicazione. Usalo per vedere il testo esatto prima di modificarlo, o per confrontare ciò che è online con l’ultima bozza.',
  input: readNodeInput,
  run: async ({ path, version }, { db, principal, env }) => {
    const [snapshot, versions] = await Promise.all([
      getContent(db, principal, env, path, { version }),
      listVersions(db, principal, env, path),
    ]);
    return {
      path: snapshot.node.path,
      kind: snapshot.node.kind,
      storage: snapshot.node.storage,
      version: snapshot.version,
      published: snapshot.published,
      // The body is what the agent has to work on: returned as the service saved it, with no
      // reshaping, so the agent sees the same content the site would render.
      body: snapshot.body,
      versions: versions.map((info) => ({
        version: info.version,
        published: info.published,
        createdAt: info.createdAt,
        authorUid: info.authorUid,
      })),
    };
  },
});
