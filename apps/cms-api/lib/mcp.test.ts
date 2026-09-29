import { ensureSharedNodes, getContent, saveDraft } from '@ai-cms/content/service';
import { contentAgentProfile, type Principal } from '@ai-cms/authz';
import { seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { createNode } from '@ai-cms/tree';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contentTools,
  createPageTool,
  createToolRegistry,
  deleteNodeTool,
  listNodesTool,
  publishTool,
  readNodeTool,
  registerTools,
  type ContentContext,
  type ContentExtra,
  type ContentTool,
} from '@ai-cms/mcp-tools';
import { checkPageVersion, renderValidator } from './page-rules.ts';
import { revalidateSite } from './sites.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };
const agent: Principal = { ...root, agent: contentAgentProfile };

/** The tools of E9.1, against the real services (TECHNICAL §7.5). */
const EXPECTED = [
  'list_nodes',
  'read_node',
  'create_page',
  'update_blocks',
  'update_meta',
  'move_node',
  'delete_node',
  'update_layout',
  'update_menu',
  'upload_asset',
  'publish',
] as const;

describe.skipIf(!testDatabaseUrl)('content tools (E9.1)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  /** The context cms-api builds (lib/mcp.ts), without the storage: no tool here needs it. */
  const context = (principal: Principal = agent, env: 'prod' | 'staging' = 'prod') =>
    ({
      principal,
      env,
      db: db(),
      toolCallId: 'call-1',
      conversationId: null,
      changesetId: null,
      storage: undefined,
      onPublished: async () => {},
      validateRendered: renderValidator(db(), principal, env),
      checkPage: (path: string, body: unknown) =>
        checkPageVersion(db(), principal, env, path, body),
    }) as unknown as ContentContext;

  /**
   * Calls a tool with an input its schema would refuse, to prove the guard inside `run` also
   * holds for the callers that skip the validation (the native loop, a CLI).
   */
  const runUnchecked = (tool: ContentTool, input: unknown, ctx: ContentContext) =>
    (tool.run as (i: unknown, c: ContentContext) => unknown)(input, ctx);

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
    await createNode(db(), root, 'prod', '/site/pages', { name: 'chi-siamo', kind: 'page' });
    await ensureSharedNodes(db(), root, 'prod');
    await saveDraft(db(), root, 'prod', '/site/pages/chi-siamo', {
      meta: { title: 'Chi siamo' },
      blocks: [{ id: 'h1', type: 'heading', level: 1, text: 'Chi siamo' }],
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('registers every tool of TECHNICAL §7.5, once each', () => {
    const registry = createToolRegistry<ContentExtra>();
    registerTools(registry, contentTools);
    const names = registry
      .list()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([...EXPECTED].sort());
    // Every tool tells the model what it needs: a description and a JSON Schema.
    for (const spec of registry.specs()) {
      expect(spec.description, spec.name).toBeTruthy();
      expect(spec.inputSchema, spec.name).toMatchObject({ type: 'object' });
    }
  });

  it('reads the tree and a page through the services, with the permissions checked', async () => {
    const listed = (await listNodesTool.run({ path: '/site/pages' }, context())) as {
      path: string;
      title: string | null;
    }[];
    expect(listed.map((entry) => entry.path)).toContain('/site/pages/chi-siamo');

    const read = (await readNodeTool.run({ path: '/site/pages/chi-siamo' }, context())) as {
      body: { meta: { title: string } };
      version: number;
    };
    expect(read.version).toBe(1);
    expect(read.body.meta.title).toBe('Chi siamo');
  });

  it('writes a page and answers with the HTML violations of the rendered draft', async () => {
    const result = (await createPageTool.run(
      {
        parent: '/site/pages',
        name: 'servizi',
        title: 'Servizi',
        // Two h1: the draft is valid content but breaks the rules of the site.
        blocks: [
          { id: 'a', type: 'heading', level: 1, text: 'Servizi' },
          { id: 'b', type: 'heading', level: 1, text: 'Cosa facciamo' },
        ],
      },
      context(),
    )) as { path: string; violations: string[] };

    expect(result.path).toBe('/site/pages/servizi');
    expect(result.violations.join('\n')).toContain('<h1>');
    // The draft is saved even when the rules complain: the agent corrects it and rewrites.
    const saved = await getContent(db(), root, 'prod', '/site/pages/servizi');
    expect(saved.body).toMatchObject({ meta: { title: 'Servizi' } });
  });

  it('refuses to publish a page with blocking errors, and publishes a clean one (E6.7)', async () => {
    await expect(publishTool.run({ path: '/site/pages/servizi' }, context())).rejects.toThrow(
      /non è pubblicabile/,
    );

    const result = (await publishTool.run({ path: '/site/pages/chi-siamo' }, context())) as {
      status: string;
      version: number;
    };
    expect(result).toMatchObject({ status: 'published', version: 1 });
    // The revalidation of the site is what tells it to regenerate: no secret call in the test.
    expect(revalidateSite).toBeTypeOf('function');
  });

  it('does not let the agent delete a node without the user confirming it (FR-06)', async () => {
    await createNode(db(), root, 'prod', '/site/pages', { name: 'da-eliminare', kind: 'page' });
    await saveDraft(db(), root, 'prod', '/site/pages/da-eliminare', {
      meta: { title: 'Da eliminare' },
      blocks: [],
    });
    await expect(
      runUnchecked(deleteNodeTool, { path: '/site/pages/da-eliminare' }, context()),
    ).rejects.toThrow(/conferma|confirm/i);
    // Nothing was deleted: the tool never reached the service.
    await expect(getContent(db(), root, 'prod', '/site/pages/da-eliminare')).resolves.toMatchObject(
      { version: 1 },
    );

    const deleted = (await deleteNodeTool.run(
      { path: '/site/pages/da-eliminare', confirm: true },
      context(),
    )) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);
  });

  it('keeps the agent inside what it may write: the content agent profile applies (E9.6)', async () => {
    // The tools go through the services, so the profile decides: this only proves the wiring.
    const result = (await createPageTool.run(
      { parent: '/site/pages', name: 'dal-profilo' },
      context(),
    )) as { path: string };
    expect(result.path).toBe('/site/pages/dal-profilo');
  });
});
