/**
 * The page write tools against a real database (E9.1).
 *
 * The interesting part of these tests is not that the services work (they have their own tests)
 * but that the tools wrap them correctly: the paths and URLs that come back, the version the
 * agent has to reuse, the refusals (FR-06) and, above all, that the HTML violations of what was
 * just written reach the agent instead of staying inside cms-api.
 */
import type { Principal } from '@ai-cms/authz';
import type { PageBody } from '@ai-cms/content';
import { getContent, saveDraft } from '@ai-cms/content/service';
import type { AssetStorage } from '@ai-cms/content/assets';
import { ConflictError, NotFoundError, ValidationError, createNode, getNode } from '@ai-cms/tree';
import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { createToolRegistry } from '../registry.ts';
import type { ContentContext, ContentExtra, ContentTool, WriteResult } from './context.ts';
import {
  createPageTool,
  deleteNodeTool,
  moveNodeTool,
  updateBlocksTool,
  updateMetaTool,
} from './pages.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };

const paragraph = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });

/** The tools always render the page they just wrote; this is what the agent is told about it. */
const missingTitle = async () => ({ errors: ['Manca il <title>.'], warnings: [] });

const pageBody = (body: unknown): PageBody => body as PageBody;

/**
 * Runs a tool on the input the test wants, without going through the registry: the refusals that
 * a schema cannot express (a missing `confirm`, FR-06) have to be reachable to be tested.
 */
async function runTool<T>(tool: ContentTool, input: unknown, ctx: ContentContext): Promise<T> {
  return (await tool.run(input as z.output<z.ZodObject>, ctx)) as T;
}

interface CreatedPage extends WriteResult {
  url: string | null;
}

interface MovedNode {
  path: string;
  version: number;
}

interface DeletedNode {
  path: string;
  deleted: true;
}

describe.skipIf(!testDatabaseUrl)('content write tools', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;
  const context = (extra: Partial<ContentExtra> = {}): ContentContext => ({
    db: db(),
    principal: root,
    env: 'prod',
    toolCallId: 't1',
    conversationId: null,
    changesetId: null,
    // The write tools on pages never touch the storage: the cast only fills the contract.
    storage: {} as AssetStorage,
    onPublished: async () => {},
    validateRendered: async () => ({ errors: [] }),
    checkPage: async () => ({ errors: [], warnings: [] }),
    ...extra,
  });

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
    await createNode(db(), root, 'prod', '/site/pages', { name: 'chi-siamo', kind: 'page' });
    // The page the content tools work on needs a draft: they read the latest version before
    // patching it, and a node without one has nothing to patch.
    await saveDraft(
      db(),
      root,
      'prod',
      '/site/pages/chi-siamo',
      { meta: { title: 'Chi siamo' }, blocks: [paragraph('b1', 'Siamo di Perugia dal 1998.')] },
      {},
    );
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('create_page crea nodo e prima bozza e restituisce url e violazioni', async () => {
    const result = await runTool<CreatedPage>(
      createPageTool,
      { parent: '/site/pages', name: 'contatti', title: 'Contatti' },
      context({ checkPage: missingTitle }),
    );
    expect(result).toMatchObject({
      path: '/site/pages/contatti',
      url: '/contatti',
      version: 1,
      violations: ['Manca il <title>.'],
    });
    expect(await getNode(db(), root, 'prod', '/site/pages/contatti')).toMatchObject({
      name: 'contatti',
      kind: 'page',
    });
    const content = await getContent(db(), root, 'prod', '/site/pages/contatti');
    expect(content.version).toBe(1);
    expect(content.body).toMatchObject({ meta: { title: 'Contatti' }, blocks: [] });
  });

  it('create_page con i blocchi scrive subito la bozza e restituisce le violazioni', async () => {
    const result = await runTool<CreatedPage>(
      createPageTool,
      {
        parent: '/site/pages',
        name: 'servizi',
        title: 'Servizi',
        description: 'I servizi che offriamo e dove trovarli',
        blocks: [paragraph('b1', 'Ristorazione, hotel e sale riunioni.')],
      },
      // The violation of the page just written is what the agent gets back (TECHNICAL §11).
      context({ checkPage: missingTitle }),
    );
    // `createPage` writes the empty version 1, the initial content lands on the next one.
    expect(result).toMatchObject({
      path: '/site/pages/servizi',
      url: '/servizi',
      version: 2,
      violations: ['Manca il <title>.'],
    });
    const content = await getContent(db(), root, 'prod', '/site/pages/servizi');
    expect(content.body).toMatchObject({
      meta: { title: 'Servizi', description: 'I servizi che offriamo e dove trovarli' },
      blocks: [paragraph('b1', 'Ristorazione, hotel e sale riunioni.')],
    });
  });

  it('update_blocks applica update e insert e crea una nuova versione', async () => {
    const result = await runTool<WriteResult>(
      updateBlocksTool,
      {
        path: '/site/pages/chi-siamo',
        operations: [
          { op: 'update', id: 'b1', fields: { content: [{ text: 'Siamo di Perugia dal 1998.' }] } },
          {
            op: 'insert',
            after: 'b1',
            block: paragraph('b2', 'Venite a trovarci in centro.'),
          },
        ],
      },
      context({ checkPage: missingTitle }),
    );
    expect(result).toMatchObject({
      path: '/site/pages/chi-siamo',
      version: 2,
      violations: ['Manca il <title>.'],
    });
    const content = await getContent(db(), root, 'prod', '/site/pages/chi-siamo');
    expect(pageBody(content.body).blocks).toEqual([
      paragraph('b1', 'Siamo di Perugia dal 1998.'),
      paragraph('b2', 'Venite a trovarci in centro.'),
    ]);
  });

  it('update_blocks con un patch non applicabile non scrive niente', async () => {
    const failure = runTool<WriteResult>(
      updateBlocksTool,
      { path: '/site/pages/chi-siamo', operations: [{ op: 'remove', id: 'inesistente' }] },
      context(),
    );
    await expect(failure).rejects.toThrow(ValidationError);
    await expect(failure).rejects.toThrow(/inesistente/);
    const content = await getContent(db(), root, 'prod', '/site/pages/chi-siamo');
    expect(content.version).toBe(2);
  });

  it('update_blocks con expectedVersion sbagliato segnala il conflitto', async () => {
    await expect(
      runTool<WriteResult>(
        updateBlocksTool,
        {
          path: '/site/pages/chi-siamo',
          operations: [{ op: 'remove', id: 'b1' }],
          expectedVersion: 1,
        },
        context(),
      ),
    ).rejects.toThrow(ConflictError);
    const content = await getContent(db(), root, 'prod', '/site/pages/chi-siamo');
    expect(content.version).toBe(2);
  });

  it('update_meta sostituisce i metadati e lascia i blocchi', async () => {
    const saved = await runTool<WriteResult>(
      updateMetaTool,
      { path: '/site/pages/chi-siamo', meta: { title: 'Chi siamo', lang: 'it' } },
      context(),
    );
    expect(saved).toMatchObject({ path: '/site/pages/chi-siamo', version: 3, violations: [] });
    let content = await getContent(db(), root, 'prod', '/site/pages/chi-siamo');
    expect(pageBody(content.body).meta).toMatchObject({ title: 'Chi siamo', lang: 'it' });
    expect(pageBody(content.body).blocks).toHaveLength(2);

    // The meta replaces: the `lang` is gone because it was not sent again.
    const replaced = await runTool<WriteResult>(
      updateMetaTool,
      { path: '/site/pages/chi-siamo', meta: { title: 'Chi siamo' } },
      context(),
    );
    expect(replaced.version).toBe(4);
    content = await getContent(db(), root, 'prod', '/site/pages/chi-siamo');
    expect(pageBody(content.body).meta).toEqual({ title: 'Chi siamo' });
    expect(pageBody(content.body).blocks).toHaveLength(2);
  });

  it('move_node sposta e rinomina il nodo', async () => {
    await createNode(db(), root, 'prod', '/site/pages', { name: 'da-spostare', kind: 'page' });
    const before = await getNode(db(), root, 'prod', '/site/pages/da-spostare');
    const result = await runTool<MovedNode>(
      moveNodeTool,
      {
        path: '/site/pages/da-spostare',
        newParent: '/site/pages/chi-siamo',
        name: 'come-contattarci',
      },
      context(),
    );
    expect(result.path).toBe('/site/pages/chi-siamo/come-contattarci');
    expect(result.version).toBeGreaterThan(before.version);
    await expect(getNode(db(), root, 'prod', '/site/pages/da-spostare')).rejects.toThrow(
      NotFoundError,
    );
    expect(
      await getNode(db(), root, 'prod', '/site/pages/chi-siamo/come-contattarci'),
    ).toMatchObject({ name: 'come-contattarci' });
  });

  it('move_node rifiuta di spostare un nodo dentro se stesso', async () => {
    await expect(
      runTool<MovedNode>(
        moveNodeTool,
        { path: '/site/pages/chi-siamo', newParent: '/site/pages/chi-siamo' },
        context(),
      ),
    ).rejects.toThrow(/Non si può spostare .+ dentro se stesso/);
    expect(await getNode(db(), root, 'prod', '/site/pages/chi-siamo')).toMatchObject({
      name: 'chi-siamo',
    });
  });

  it('delete_node senza conferma non cancella il nodo', async () => {
    await createNode(db(), root, 'prod', '/site/pages', { name: 'da-eliminare', kind: 'page' });
    const failure = runTool<DeletedNode>(
      deleteNodeTool,
      { path: '/site/pages/da-eliminare' },
      context(),
    );
    await expect(failure).rejects.toThrow(/chiedi prima all'utente la conferma/);
    expect(await getNode(db(), root, 'prod', '/site/pages/da-eliminare')).toMatchObject({
      name: 'da-eliminare',
      deletedAt: null,
    });
  });

  it('delete_node con confirm cancella il nodo', async () => {
    const result = await runTool<DeletedNode>(
      deleteNodeTool,
      { path: '/site/pages/da-eliminare', confirm: true },
      context(),
    );
    expect(result).toEqual({ path: '/site/pages/da-eliminare', deleted: true });
    await expect(getNode(db(), root, 'prod', '/site/pages/da-eliminare')).rejects.toThrow(
      NotFoundError,
    );
  });

  it('delete_node non cancella la struttura di base del sito', async () => {
    await expect(
      runTool<DeletedNode>(deleteNodeTool, { path: '/site', confirm: true }, context()),
    ).rejects.toThrow(ValidationError);
    expect(await getNode(db(), root, 'prod', '/site')).toMatchObject({ name: 'site' });
  });

  it('delete_node senza conferma non arriva al servizio neanche dal registro', async () => {
    const registry = createToolRegistry<ContentExtra>();
    registry.register(deleteNodeTool);
    await createNode(db(), root, 'prod', '/site/pages', { name: 'da-eliminare-2', kind: 'page' });
    const result = await registry.call(
      'delete_node',
      { path: '/site/pages/da-eliminare-2' },
      context(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/confirm: true/);
    expect(await getNode(db(), root, 'prod', '/site/pages/da-eliminare-2')).toMatchObject({
      deletedAt: null,
    });
  });
});
