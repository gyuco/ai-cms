import { contentAgentProfile, type Principal } from '@ai-cms/authz';
import { schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { NotFoundError, getNode } from '@ai-cms/tree';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PlanError,
  executePlan,
  getContent,
  listVersions,
  saveDraft,
  type PlanOperation,
} from './index.ts';

const root: Principal = { uid: 0, username: 'root', status: 'active' };

const page = (title: string, ...paragraphs: [string, string][]) => ({
  meta: { title },
  blocks: paragraphs.map(([id, text]) => ({ id, type: 'paragraph', content: [{ text }] })),
});

describe.skipIf(!testDatabaseUrl)('transactional plans', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const db = () => database.db;

  const counts = async () => {
    const [row] = await database.sql`
      SELECT (SELECT count(*) FROM nodes)::int AS nodes,
             (SELECT count(*) FROM content_versions)::int AS versions,
             (SELECT count(*) FROM publications)::int AS publications,
             (SELECT count(*) FROM audit_log)::int AS audit`;
    return row;
  };

  const planError = async (promise: Promise<unknown>) => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanError);
    return error as PlanError;
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('applies a multi-node plan in one go and returns paths and versions', async () => {
    const hook = vi.fn(async () => {});
    const result = await executePlan(
      db(),
      root,
      'prod',
      [
        { op: 'createNode', parentPath: '/site/pages', name: 'servizi', kind: 'dir' },
        {
          op: 'createPage',
          parentPath: '/site/pages/servizi',
          name: 'consulenza',
          body: page('Consulenza', ['p1', 'Offriamo consulenza.']),
        },
        { op: 'updateMeta', path: '/site/pages/servizi/consulenza', meta: { description: 'Desc' } },
        {
          op: 'patchBlocks',
          path: '/site/pages/servizi/consulenza',
          operations: [
            {
              op: 'insert',
              block: { id: 'h', type: 'heading', level: 1, text: 'Consulenza' },
              index: 0,
            },
          ],
        },
        { op: 'publish', path: '/site/pages/servizi/consulenza' },
        { op: 'rename', path: '/site/pages/servizi', name: 'offerta' },
      ],
      { conversationId: '00000000-0000-4000-8000-000000000002', onPublished: hook },
    );
    expect(result.dryRun).toBe(false);
    expect(result.touched).toEqual(['/site/pages/offerta', '/site/pages/offerta/consulenza']);
    expect(result.versions.map((v) => [v.path, v.version])).toEqual([
      ['/site/pages/offerta/consulenza', 1],
      ['/site/pages/offerta/consulenza', 2],
      ['/site/pages/offerta/consulenza', 3],
    ]);
    expect(result.published).toEqual(['/site/pages/offerta/consulenza']);
    expect(hook).toHaveBeenCalledOnce();
    expect(result.revalidate).toEqual(
      expect.arrayContaining([
        '/site/pages/servizi',
        '/site/pages/offerta',
        '/site/pages/offerta/consulenza',
      ]),
    );

    const content = await getContent(db(), root, 'prod', '/site/pages/offerta/consulenza', {
      version: 'published',
    });
    expect(content.body).toEqual({
      meta: { title: 'Consulenza', description: 'Desc' },
      blocks: [
        { id: 'h', type: 'heading', level: 1, text: 'Consulenza' },
        { id: 'p1', type: 'paragraph', content: [{ text: 'Offriamo consulenza.' }] },
      ],
    });
    expect(content.conversationId).toBe('00000000-0000-4000-8000-000000000002');
    const [row] = await database.sql`
      SELECT version FROM published_content WHERE path = 'site.pages.offerta.consulenza' AND env = 'prod'`;
    expect(row!.version).toBe(3);
  });

  it('validates everything first and reports all problems at once', async () => {
    const before = await counts();
    const error = await planError(
      executePlan(db(), root, 'prod', [
        { op: 'createPage', parentPath: '/site/pages', name: 'nuova', body: page('Nuova') },
        { op: 'createPage', parentPath: '/site/pages', name: 'nuova', body: page('Doppia') },
        { op: 'updateBody', path: '/site/pages/inesistente', body: page('x') },
        {
          op: 'updateBody',
          path: '/site/pages/nuova',
          body: { meta: {}, blocks: [{ id: 'x', type: 'boh' }] },
        },
        { op: 'delete', path: '/site/pages' },
        { op: 'createPage', parentPath: '/code/api', name: 'x', body: page('x') },
        {
          op: 'move',
          path: '/site/pages/offerta',
          newParentPath: '/site/pages/offerta/consulenza',
        },
        { op: 'move', path: '/site/pages/offerta', newParentPath: '/site/pages/nuova' },
        { op: 'updateBody', path: '/site/pages/offerta/consulenza', body: page('Ok') },
      ]),
    );
    expect(error.planIssues.map((i) => [i.index, i.kind])).toEqual([
      [1, 'invalid'],
      [2, 'not-found'],
      [3, 'invalid'],
      [4, 'invalid'],
      [5, 'authz'],
      [6, 'invalid'],
      [8, 'not-found'],
    ]);
    expect(error.message).toContain('nessuna modifica è stata salvata');
    expect(error.message).toContain('operazione 2 (createPage /site/pages/nuova)');
    // Only the authz denial is audited; nothing else is written.
    const after = await counts();
    expect(after).toEqual({ ...before, audit: before!.audit + 1 });
  });

  it('rejects malformed plans before looking at the database', async () => {
    const error = await planError(
      executePlan(db(), root, 'prod', [{ op: 'explode', path: '/x' } as unknown as PlanOperation]),
    );
    expect(error.planIssues[0]).toMatchObject({ index: 0, kind: 'invalid' });
    await expect(executePlan(db(), root, 'prod', [])).rejects.toThrow(PlanError);
  });

  it('rejects CSS in an html block and points to the developer agent', async () => {
    const error = await planError(
      executePlan(db(), root, 'prod', [
        {
          op: 'updateBody',
          path: '/site/pages/index',
          body: {
            meta: {},
            blocks: [{ id: 'css', type: 'html', html: '<style>.h { color: red }</style>' }],
          },
        },
      ]),
    );
    expect(error.message).toContain('blocco "css"');
    expect(error.message).toContain('un tag <style>');
    expect(error.message).toContain('Il CSS non va nei blocchi HTML');
    expect(error.message).toContain('agente sviluppatore');
  });

  it('tells the model the correct shape when blocks are malformed', async () => {
    // The mistakes seen with a real model: `blocks` as an object, a heading without level,
    // a paragraph whose content is an object.
    const asObject = await planError(
      executePlan(db(), root, 'prod', [
        { op: 'updateBody', path: '/site/pages/index', body: { blocks: { a: 1 } } },
      ]),
    );
    expect(asObject.message).toContain('Forma corretta');
    expect(asObject.message).toContain('`blocks` è sempre un ARRAY');
    expect(asObject.message).toContain('"level":1');

    const noLevel = await planError(
      executePlan(db(), root, 'prod', [
        {
          op: 'updateBody',
          path: '/site/pages/index',
          body: {
            blocks: [
              { id: 't', type: 'heading', text: 'Ciao' },
              { id: 'p', type: 'paragraph', content: { text: 'Ciao' } },
            ],
          },
        },
      ]),
    );
    expect(noLevel.message).toContain('level');
    expect(noLevel.message).toContain('`level` da 1 a 6');
    expect(noLevel.message).toContain('`content` è un ARRAY di frammenti');

    const menu = await planError(
      executePlan(db(), root, 'prod', [
        {
          op: 'createNode',
          parentPath: '/site/menus',
          name: 'main',
          kind: 'menu',
          body: { blocks: [] },
        },
      ]),
    );
    expect(menu.message).toContain('"items"');
  });

  it('leaves no trace when an operation fails halfway through', async () => {
    await saveDraft(db(), root, 'prod', '/site/pages/index', page('Home', ['a', 'Ciao']));
    const before = await counts();
    const home = await listVersions(db(), root, 'prod', '/site/pages/index');
    const error = await planError(
      executePlan(db(), root, 'prod', [
        { op: 'createPage', parentPath: '/site/pages', name: 'temporanea', body: page('T') },
        { op: 'updateBody', path: '/site/pages/index', body: page('Home 2') },
        { op: 'move', path: '/site/pages/offerta', newParentPath: '/site/pages/temporanea' },
        // Validation cannot know about this conflict: it fails during execution.
        { op: 'updateBody', path: '/site/pages/index', body: page('Home 3'), expectedVersion: 1 },
      ]),
    );
    expect(error.planIssues).toEqual([expect.objectContaining({ index: 3, kind: 'conflict' })]);
    expect(await counts()).toEqual(before);
    expect(await listVersions(db(), root, 'prod', '/site/pages/index')).toEqual(home);
    await expect(getNode(db(), root, 'prod', '/site/pages/temporanea')).rejects.toThrow(
      NotFoundError,
    );
    await expect(getNode(db(), root, 'prod', '/site/pages/offerta')).resolves.toBeDefined();
  });

  it('fails publishing when the rendered page breaks the HTML rules', async () => {
    const before = await counts();
    const validateRendered = vi.fn(async (path: string) =>
      path === '/site/pages/index' ? { errors: ['Manca il titolo h1'] } : { errors: [] },
    );
    const error = await planError(
      executePlan(
        db(),
        root,
        'prod',
        [
          { op: 'publish', path: '/site/pages/offerta/consulenza' },
          { op: 'publish', path: '/site/pages/index' },
        ],
        { validateRendered },
      ),
    );
    expect(error.planIssues[0]).toMatchObject({ index: 1, kind: 'rendering' });
    expect(error.message).toContain('Manca il titolo h1');
    expect(validateRendered).toHaveBeenCalledWith('/site/pages/index', page('Home', ['a', 'Ciao']));
    expect(await counts()).toEqual(before);
  });

  it('previews a dry run without writing anything', async () => {
    const before = await counts();
    const result = await executePlan(
      db(),
      root,
      'prod',
      [
        {
          op: 'patchBlocks',
          path: '/site/pages/index',
          operations: [
            { op: 'update', id: 'a', fields: { content: [{ text: 'Benvenuti' }] } },
            { op: 'insert', block: { id: 'b', type: 'paragraph', content: [{ text: 'Nuovo' }] } },
          ],
        },
        { op: 'createPage', parentPath: '/site/pages', name: 'contatti', body: page('Contatti') },
        { op: 'move', path: '/site/pages/contatti', newParentPath: '/site/pages/offerta' },
        { op: 'publish', path: '/site/pages/offerta/contatti' },
      ],
      { dryRun: true },
    );
    expect(result.dryRun).toBe(true);
    expect(result.published).toEqual(['/site/pages/offerta/contatti']);
    const [home, contatti] = result.preview!;
    expect(home).toMatchObject({ path: '/site/pages/index', created: false, baseVersion: 2 });
    expect(home!.diff.blocks.modified.map((m) => m.id)).toEqual(['a']);
    expect(home!.diff.blocks.added.map((m) => m.id)).toEqual(['b']);
    expect(contatti).toMatchObject({
      path: '/site/pages/offerta/contatti',
      created: true,
      baseVersion: null,
      body: page('Contatti'),
    });
    expect(contatti!.diff.fields).toEqual([
      { field: 'meta.title', before: undefined, after: 'Contatti' },
    ]);
    expect(await counts()).toEqual(before);
  });

  it('checks agent permissions on every operation', async () => {
    const agent: Principal = { ...root, agent: contentAgentProfile, scope: ['site.pages.offerta'] };
    const error = await planError(
      executePlan(db(), agent, 'prod', [
        { op: 'updateBody', path: '/site/pages/offerta/consulenza', body: page('Ok') },
        { op: 'updateBody', path: '/site/pages/index', body: page('No') },
      ]),
    );
    expect(error.planIssues).toEqual([expect.objectContaining({ index: 1, kind: 'authz' })]);
    const denied = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'plan.validate'));
    expect(denied.at(-1)).toMatchObject({
      outcome: 'denied',
      agent: 'content-agent',
      nodePath: 'site.pages.index',
    });
    const [{ n }] = (await db().execute(
      sql`SELECT count(*)::int AS n FROM content_versions WHERE via_agent = 'content-agent'`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(0);
  });
});
