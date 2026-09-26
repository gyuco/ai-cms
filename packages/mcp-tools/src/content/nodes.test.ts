import type { Principal } from '@ai-cms/authz';
import { getContent, publish, saveDraft } from '@ai-cms/content/service';
import type { AssetStorage } from '@ai-cms/content/assets';
import { NotFoundError, createNode } from '@ai-cms/tree';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { createToolRegistry } from '../registry.ts';
import type { ContentContext, ContentTool } from './context.ts';
import { listNodesTool, readNodeTool } from './nodes.ts';
import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';

const root: Principal = { uid: 0, username: 'root', status: 'active' };

const page = (title: string, ...texts: string[]) => ({
  meta: { title },
  blocks: texts.map((text, i) => ({ id: `b${i}`, type: 'paragraph', content: [{ text }] })),
});

/** What the two tools answer: `Tool.run` is declared as `unknown` (registry.ts). */
interface NodeListEntry {
  path: string;
  name: string;
  kind: string;
  url: string | null;
  title: string | null;
  hasChildren: boolean;
  status: { latestVersion: number | null; publishedVersion: number | null; hasDraft: boolean };
}

interface NodeSnapshot {
  path: string;
  kind: string;
  storage: string;
  version: number;
  published: boolean;
  body: unknown;
  versions: { version: number; published: boolean; createdAt: Date; authorUid: number }[];
}

async function runTool<T>(tool: ContentTool, input: unknown, ctx: ContentContext): Promise<T> {
  return (await tool.run(input as z.output<z.ZodObject>, ctx)) as T;
}

describe.skipIf(!testDatabaseUrl)('node reading tools', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;
  const ctx = (): ContentContext => ({
    db: db(),
    principal: root,
    env: 'prod',
    toolCallId: 't1',
    conversationId: null,
    changesetId: null,
    // Never touched by these two tools: they only read through the content services.
    storage: {} as AssetStorage,
    onPublished: async () => {},
    validateRendered: async () => ({ errors: [] }),
    checkPage: async () => ({ errors: [], warnings: [] }),
  });
  const listNodes = (path: string) => runTool<NodeListEntry[]>(listNodesTool, { path }, ctx());
  const readNode = (path: string, version?: number | 'latest' | 'published') =>
    runTool<NodeSnapshot>(readNodeTool, { path, version }, ctx());

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
    await createNode(db(), root, 'prod', '/site/pages', { name: 'chi-siamo', kind: 'page' });
    await createNode(db(), root, 'prod', '/site/pages/chi-siamo', { name: 'storia', kind: 'page' });
    // Version 1 goes online, version 2 stays a draft: the page is published and drafted.
    await saveDraft(db(), root, 'prod', '/site/pages/chi-siamo', page('Chi siamo', 'Prima'));
    await publish(db(), root, 'prod', '/site/pages/chi-siamo');
    await saveDraft(db(), root, 'prod', '/site/pages/chi-siamo', page('Chi siamo', 'Ultima'));
    // A subfolder with a draft only, so the list shows both states.
    await saveDraft(db(), root, 'prod', '/site/pages/chi-siamo/storia', page('La nostra storia'));
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('asks for the permissions of TECHNICAL §7.5', () => {
    expect([listNodesTool.name, listNodesTool.action]).toEqual(['list_nodes', 'list']);
    expect([readNodeTool.name, readNodeTool.action]).toEqual(['read_node', 'read']);
  });

  it('tells the model that only the path is required, and the version is not', () => {
    const registry = createToolRegistry();
    registry.register(listNodesTool);
    registry.register(readNodeTool);
    const [list, read] = registry.specs();
    expect(Object.keys(list!.inputSchema.properties as object)).toEqual(['path']);
    expect(list!.inputSchema.required).toEqual(['path']);
    expect(Object.keys(read!.inputSchema.properties as object).sort()).toEqual(['path', 'version']);
    expect(read!.inputSchema.required).toEqual(['path']);
  });

  it('lists the children of a folder with title, state and subfolders', async () => {
    expect(await listNodes('/site/pages')).toEqual([
      {
        path: '/site/pages/chi-siamo',
        name: 'chi-siamo',
        kind: 'page',
        url: '/chi-siamo',
        title: 'Chi siamo',
        hasChildren: true,
        status: { latestVersion: 2, publishedVersion: 1, hasDraft: true },
      },
      {
        path: '/site/pages/index',
        name: 'index',
        kind: 'page',
        url: '/',
        // The seeded home page has no meta.title: the title exists only for pages, and only
        // once somebody has written one.
        title: null,
        hasChildren: false,
        status: { latestVersion: 1, publishedVersion: 1, hasDraft: false },
      },
    ]);

    expect(await listNodes('/site/pages/chi-siamo')).toEqual([
      {
        path: '/site/pages/chi-siamo/storia',
        name: 'storia',
        kind: 'page',
        url: '/chi-siamo/storia',
        title: 'La nostra storia',
        hasChildren: false,
        // Saved but never published: only the draft exists.
        status: { latestVersion: 1, publishedVersion: null, hasDraft: true },
      },
    ]);
  });

  it('reads the body of a node and lists its versions', async () => {
    const node = await readNode('/site/pages/chi-siamo');
    expect(node).toMatchObject({
      path: '/site/pages/chi-siamo',
      kind: 'page',
      storage: 'db',
      // The default is the latest version, which is not the one online.
      version: 2,
      published: false,
    });
    expect(node.body).toEqual(page('Chi siamo', 'Ultima'));
    expect(node.versions).toEqual([
      { version: 2, published: false, createdAt: expect.any(Date), authorUid: 0 },
      { version: 1, published: true, createdAt: expect.any(Date), authorUid: 0 },
    ]);

    // The body is what the service saved: the agent reads it as it is.
    const saved = await getContent(db(), root, 'prod', '/site/pages/chi-siamo');
    expect(node.body).toEqual(saved.body);
  });

  it('reads the version online when asked for the published one', async () => {
    const online = await readNode('/site/pages/chi-siamo', 'published');
    expect(online).toMatchObject({ version: 1, published: true });
    expect(online.body).toEqual(page('Chi siamo', 'Prima'));
    expect(online.versions.map((v) => v.version)).toEqual([2, 1]);

    // A number is the other half of VersionRef.
    const first = await readNode('/site/pages/chi-siamo', 1);
    expect(first).toMatchObject({ version: 1, published: true });
    expect(first.body).toEqual(online.body);
  });

  it('propagates NotFoundError instead of answering an empty node', async () => {
    const missing = await readNode('/site/pages/chi-siamo', 99).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((missing as NotFoundError).message).toContain('non ha una versione 99');

    // Never published: "published" has nothing to point at.
    const draft = await readNode('/site/pages/chi-siamo/storia', 'published').catch(
      (error: unknown) => error,
    );
    expect(draft).toBeInstanceOf(NotFoundError);
    expect((draft as NotFoundError).message).toContain('non è pubblicato in prod');

    // Through the registry the failure is an error result, never a result without a body.
    const registry = createToolRegistry();
    registry.register(listNodesTool);
    registry.register(readNodeTool);
    const failed = await registry.call(
      'read_node',
      { path: '/site/pages/chi-siamo', version: 99 },
      ctx(),
    );
    expect(failed.isError).toBe(true);
    expect(failed.content).toMatch(/non ha una versione 99/);
  });

  it('rejects an empty path before reaching the services', async () => {
    const registry = createToolRegistry();
    registry.register(listNodesTool);
    const invalid = await registry.call('list_nodes', { path: '  ' }, ctx());
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toMatch(/^Input non valido per list_nodes/);
  });
});
