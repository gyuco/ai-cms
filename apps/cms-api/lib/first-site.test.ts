/**
 * E9.7: the first site, built only through the chat (PRD §6.2). A scripted agent stands in for
 * the model: it proposes, as plans, what a person would ask for ("un sito per il mio studio di
 * architettura: home, Progetti, Chi siamo e Contatti, con header e menu"), and the person
 * confirms. Everything else is the real thing: the chat turn, the plan store, the content
 * services, authz, audit, and the HTML rules on what gets published.
 */
import type { ChatStreamEvent } from '@ai-cms/agents';
import type { ChatEngine, ChatEvent, ChatRequest } from '@ai-cms/ai';
import { getConversation } from '@ai-cms/ai-config';
import { verifyAuditChain } from '@ai-cms/audit';
import { getSharedElements } from '@ai-cms/content/service';
import { schema, seed } from '@ai-cms/db';
import { createTestDatabase, testDatabaseUrl } from '@ai-cms/db/testing';
import { validateDocument } from '@ai-cms/html-rules';
import { renderPageDocument } from '@ai-cms/site-kit/document';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  turns: [] as ChatEvent[][],
  requests: [] as ChatRequest[],
}));

vi.mock('./db.ts', () => ({ db: () => state.db }));
vi.mock('./assets.ts', () => ({ assetStorage: async () => undefined }));
vi.mock('./sites.ts', () => ({ revalidateSite: async () => undefined }));
vi.mock('./ai.ts', () => ({
  gateway: () => ({
    async open() {
      const engine: ChatEngine = {
        provider: 'anthropic',
        capabilities: async () => ({ tools: true, vision: false, streaming: true }),
        async *stream(req) {
          state.requests.push(structuredClone(req));
          const turn = state.turns.shift();
          if (!turn) throw new Error('no more scripted turns');
          yield* turn;
        },
      };
      return { engine, model: 'fake-model', role: 'content-agent', connection: { id: 'fake' } };
    },
  }),
}));

const { answerPlan, pendingPlanPreview, runChatTurn } = await import('./chat.ts');
const { checkPageVersion } = await import('./page-rules.ts');

const owner = { uid: 0, env: 'prod' } as const;
const root = { uid: 0, username: 'root', status: 'active' } as const;

const call = (id: string, name: string, input: unknown): ChatEvent[] => [
  { type: 'tool_call', id, name, input },
  { type: 'done', stopReason: 'tool_use' },
];
const say = (text: string): ChatEvent[] => [
  { type: 'text_delta', text },
  { type: 'done', stopReason: 'end_turn' },
];

async function turn(message: string, conversationId: string | null, path: string | null) {
  const response = runChatTurn(
    owner,
    { message, conversationId, path, selected: null },
    new AbortController().signal,
  );
  const text = await response.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.split('\ndata: ')[1]!) as ChatStreamEvent);
}

const heading = (id: string, text: string, level = 1) => ({ id, type: 'heading', level, text });
const paragraph = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });

const SITE_NAME = 'Studio Rossi Architetti';
const MENU = [
  { label: 'Home', href: '/' },
  { label: 'Progetti', href: '/progetti' },
  { label: 'Chi siamo', href: '/chi-siamo' },
  { label: 'Contatti', href: '/contatti' },
];

/** Plan 1: identity of the site, then the header, footer and menu every page shares. */
const sharedPlan = [
  {
    op: 'updateBody',
    path: '/site/settings',
    body: { name: SITE_NAME, lang: 'it', titleTemplate: `%s · ${SITE_NAME}` },
  },
  { op: 'publish', path: '/site/settings' },
  {
    op: 'createNode',
    parentPath: '/site/layouts',
    name: 'header',
    kind: 'layout',
    body: {
      blocks: [{ id: 'brand', type: 'paragraph', content: [{ text: SITE_NAME, href: '/' }] }],
    },
  },
  {
    op: 'createNode',
    parentPath: '/site/layouts',
    name: 'footer',
    kind: 'layout',
    body: { blocks: [paragraph('copy', `© ${SITE_NAME}, via Roma 1, Cagliari`)] },
  },
  {
    op: 'createNode',
    parentPath: '/site/menus',
    name: 'main',
    kind: 'menu',
    body: { items: MENU },
  },
  { op: 'publish', path: '/site/layouts/header' },
  { op: 'publish', path: '/site/layouts/footer' },
  { op: 'publish', path: '/site/menus/main' },
];

const pageBody = (title: string, description: string, blocks: unknown[]) => ({
  meta: { title, description },
  blocks,
});

/** Plan 2: the home page and the three pages the menu points to. */
const pagesPlan = [
  {
    op: 'updateBody',
    path: '/site/pages/index',
    body: pageBody(
      'Home',
      'Studio di architettura a Cagliari: progettiamo case, negozi e spazi di lavoro su misura.',
      [
        heading('h1', 'Architettura su misura'),
        paragraph('p1', 'Progettiamo spazi che si vivono bene, dal primo schizzo al cantiere.'),
      ],
    ),
  },
  {
    op: 'createPage',
    parentPath: '/site/pages',
    name: 'progetti',
    body: pageBody(
      'Progetti',
      'I progetti dello studio: ristrutturazioni, nuove costruzioni e allestimenti commerciali.',
      [
        heading('h1', 'Progetti'),
        heading('h2', 'Ristrutturazioni', 2),
        paragraph('p1', 'Appartamenti e case storiche riportati a nuova vita.'),
      ],
    ),
  },
  {
    op: 'createPage',
    parentPath: '/site/pages',
    name: 'chi-siamo',
    body: pageBody(
      'Chi siamo',
      'Lo studio Rossi: tre architetti, vent’anni di esperienza e un approccio artigianale.',
      [heading('h1', 'Chi siamo'), paragraph('p1', 'Siamo tre architetti con sede a Cagliari.')],
    ),
  },
  {
    op: 'createPage',
    parentPath: '/site/pages',
    name: 'contatti',
    body: pageBody(
      'Contatti',
      'Come raggiungere lo studio Rossi Architetti: indirizzo, telefono ed email per un appuntamento.',
      [
        heading('h1', 'Contatti'),
        paragraph('p1', 'Scrivici a studio@example.org per un primo incontro.'),
      ],
    ),
  },
  { op: 'publish', path: '/site/pages/index' },
  { op: 'publish', path: '/site/pages/progetti' },
  { op: 'publish', path: '/site/pages/chi-siamo' },
  { op: 'publish', path: '/site/pages/contatti' },
];

describe.skipIf(!testDatabaseUrl)('the first site, built through the chat (E9.7)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
    state.db = database.db;
    await seed(database.db, { hashPassword: async (p) => `hash:${p}` });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('goes from the blank page to a site with header, menu and four pages', async () => {
    const db = database.db;
    const blankHome = await getSharedElements(db, root, 'prod');
    expect(blankHome.menus).toEqual({});
    expect(blankHome.layouts).toEqual({});

    // --- Turn 1: the person asks for the site, from the (blank) home page. ---------------
    state.turns = [
      call('c1', 'propose_plan', { operations: sharedPlan }),
      say('Ho preparato nome del sito, header, footer e menu. Confermi?'),
    ];
    const first = await turn(
      'Crea un sito per il mio studio di architettura: home, Progetti, Chi siamo e Contatti, con header e menu',
      null,
      '/site/pages/index',
    );
    const conversationId = (first.find((e) => e.type === 'conversation') as { id: string }).id;
    expect(first.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true, blocked: false });
    expect(first.find((e) => e.type === 'plan')).toMatchObject({ plan: { destructive: false } });
    // The system prompt tells the agent it is on the blank home page of production.
    expect(state.requests[0]!.system).toContain('Pagina corrente: /site/pages/index');
    expect(state.requests[0]!.system).toContain('Ambiente: produzione.');
    // Proposed, not written.
    expect((await getSharedElements(db, root, 'prod')).menus).toEqual({});

    const shared = await answerPlan(owner, {
      conversationId,
      action: 'confirm',
      confirmDestructive: false,
    });
    expect(shared).toMatchObject({ status: 'applied' });

    // --- Turn 2: same conversation, the pages. --------------------------------------------
    state.turns = [
      call('c2', 'propose_plan', { operations: pagesPlan }),
      say('Ecco home, Progetti, Chi siamo e Contatti. Confermi?'),
    ];
    const second = await turn('Ora scrivi le pagine', conversationId, '/site/pages/index');
    expect(second.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true, blocked: false });
    // The next turn tells the agent the first plan went through.
    expect(JSON.stringify(state.requests.at(-2)!.messages.at(-1))).toContain(
      'ha confermato il piano',
    );

    // The preview on the home (E7.5) shows the new content without writing it.
    const preview = await pendingPlanPreview(owner, conversationId, '/site/pages/index');
    expect(preview?.html).toContain('Architettura su misura');
    const stillBlank = await db
      .select({ body: schema.contentVersions.body })
      .from(schema.contentVersions)
      .innerJoin(schema.nodes, eq(schema.nodes.id, schema.contentVersions.nodeId))
      .where(
        and(eq(schema.nodes.path, 'site.pages.index'), eq(schema.contentVersions.env, 'prod')),
      );
    expect(JSON.stringify(stillBlank)).not.toContain('Architettura su misura');

    const pages = await answerPlan(owner, {
      conversationId,
      action: 'confirm',
      confirmDestructive: false,
    });
    expect(pages).toMatchObject({ status: 'applied' });

    // --- The site: settings, header, footer, menu, four published pages. -------------------
    const elements = await getSharedElements(db, root, 'prod');
    expect(elements.settings?.name).toBe(SITE_NAME);
    expect(Object.keys(elements.layouts).sort()).toEqual(['footer', 'header']);
    const menu = elements.menus.main!;
    expect(menu.items.map((i) => i.href)).toEqual(MENU.map((i) => i.href));

    const published = await db
      .select({ path: schema.nodes.path })
      .from(schema.publications)
      .innerJoin(schema.nodes, eq(schema.nodes.id, schema.publications.nodeId))
      .where(
        and(
          eq(schema.publications.env, 'prod'),
          eq(schema.publications.status, 'published'),
          like(sql`${schema.nodes.path}::text`, 'site.pages.%'),
        ),
      );
    expect(published.map((p) => p.path).sort()).toEqual([
      'site.pages.chi-siamo',
      'site.pages.contatti',
      'site.pages.index',
      'site.pages.progetti',
    ]);

    // Every link of the menu is a page of the site.
    const pagePaths = new Set(published.map((p) => p.path));
    for (const item of menu.items) {
      const node = item.href === '/' ? 'site.pages.index' : `site.pages.${item.href.slice(1)}`;
      expect(pagePaths.has(node), `${item.href} punta a una pagina pubblicata`).toBe(true);
    }

    // --- The HTML of each page is valid: as the site renders it, with header and menu. ----
    for (const name of ['index', 'progetti', 'chi-siamo', 'contatti']) {
      const versions = await db
        .select({ body: schema.contentVersions.body })
        .from(schema.publications)
        .innerJoin(schema.nodes, eq(schema.nodes.id, schema.publications.nodeId))
        .innerJoin(
          schema.contentVersions,
          eq(schema.contentVersions.id, schema.publications.versionId),
        )
        .where(
          and(eq(schema.nodes.path, `site.pages.${name}`), eq(schema.publications.env, 'prod')),
        );
      const body = versions[0]!.body as { meta: { title: string; description?: string } };
      const html = renderPageDocument(
        {
          lang: 'it',
          title: `${body.meta.title} · ${SITE_NAME}`,
          description: body.meta.description,
        },
        {
          page: body as never,
          nodePath: `site.pages.${name}`,
          header: elements.layouts.header!,
          footer: elements.layouts.footer!,
          menu,
        },
      );
      expect(html).toContain('<nav aria-label="Menu principale"');
      for (const item of MENU) expect(html).toContain(`href="${item.href}"`);
      const report = await validateDocument(html);
      expect(report.errors, `${name}: ${JSON.stringify(report.errors)}`).toEqual([]);

      // The same check that gates publication agrees.
      const check = await checkPageVersion(db, root, 'prod', `/site/pages/${name}`, body);
      expect(check.errors, `${name}: ${check.errors.join('; ')}`).toEqual([]);
    }

    // --- Audit: the whole story is in the log, and the chain holds. -----------------------
    const audit = await db.select().from(schema.auditLog);
    const publishes = audit.filter((e) => e.action === 'content.publish' && e.outcome === 'ok');
    // settings + header + footer + menu + four pages
    expect(publishes.length).toBeGreaterThanOrEqual(8);
    expect(audit.some((e) => e.action === 'content.publish' && e.agent === 'content-agent')).toBe(
      true,
    );
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });

    // --- Conversations: every version the chat wrote points back to it (FR-08). -----------
    const versions = await db
      .select({
        path: schema.nodes.path,
        conversationId: schema.contentVersions.conversationId,
        viaAgent: schema.contentVersions.viaAgent,
      })
      .from(schema.contentVersions)
      .innerJoin(schema.nodes, eq(schema.nodes.id, schema.contentVersions.nodeId))
      .where(eq(schema.contentVersions.conversationId, conversationId));
    expect(versions.map((v) => v.path).sort()).toEqual([
      'site.layouts.footer',
      'site.layouts.header',
      'site.menus.main',
      'site.pages.chi-siamo',
      'site.pages.contatti',
      'site.pages.index',
      'site.pages.progetti',
      'site.settings',
    ]);
    expect(versions.every((v) => v.viaAgent === 'content-agent')).toBe(true);
    // And from the version, the conversation opens with what was said.
    const conversation = await getConversation(db, versions[0]!.conversationId!);
    expect(conversation?.messages.length).toBeGreaterThanOrEqual(4);
    expect(conversation?.nodeId).not.toBeNull();
  });
});
