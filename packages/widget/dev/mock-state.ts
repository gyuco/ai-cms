/** In-memory fake of the CMS API used by the widget's dev server (see mock-api.ts). */

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  env: 'prod' | 'staging';
}

export interface MockResult {
  status: number;
  body: unknown;
}

const ok = (body: unknown, status = 200): MockResult => ({ status, body });
const fail = (status: number, code: string, message: string): MockResult => ({
  status,
  body: { error: { code, message } },
});

const ME = {
  uid: 0,
  username: 'root',
  displayName: 'Mario Rossi',
  email: 'root@example.test',
  mustChangePassword: false,
};

interface MockVersion {
  version: number;
  body: { meta: Record<string, unknown>; blocks: unknown[] };
  authorUid: number;
  createdAt: string;
}

interface MockNode {
  kind: string;
  version: number;
  versions: MockVersion[];
  published: number | null;
}

function pageNodePath(url: string): string | null {
  if (url === '/dev/index.html') return '/site/pages/index';
  const segments = url.split('/').filter(Boolean);
  if (segments.length === 0) return '/site/pages/index';
  if (!segments.every((s) => /^[a-z0-9][a-z0-9_-]*$/.test(s))) return null;
  return `/site/pages/${segments.join('/')}`;
}

export function createMockState() {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const nodes = new Map<string, MockNode>();
  const page = (title: string | null, versions = 1, published: number | null = 1): MockNode => ({
    kind: 'page',
    version: 1,
    versions: Array.from({ length: versions }, (_, i) => ({
      version: i + 1,
      body: { meta: title ? { title, description: `Descrizione di ${title}.` } : {}, blocks: [] },
      authorUid: i % 2 === 0 ? 0 : 1001,
      createdAt: hoursAgo((versions - i) * 26),
    })),
    published,
  });
  for (const dir of ['/', '/site', '/site/pages', '/site/layouts', '/site/menus']) {
    nodes.set(dir, { kind: 'dir', version: 1, versions: [], published: null });
  }
  nodes.set('/site/pages/index', page('Home', 3, 2));
  nodes.set('/site/pages/chi-siamo', page('Chi siamo', 2, 2));
  nodes.set('/site/pages/progetti', page('Progetti', 1, null));
  nodes.set('/site/pages/progetti/casa-sul-lago', page('Casa sul lago'));
  nodes.set('/site/pages/contatti', page('Contatti'));

  const status = (node: MockNode) => {
    const latest = node.versions.at(-1)?.version ?? null;
    return {
      latestVersion: latest,
      publishedVersion: node.published,
      hasDraft: latest !== null && latest !== node.published,
    };
  };

  function context(req: MockRequest): MockResult {
    const path = pageNodePath(req.query.get('path') ?? '/');
    const node = path ? nodes.get(path) : undefined;
    return ok({
      user: ME,
      env: req.env,
      csrfToken: 'dev-csrf-token',
      node: {
        path,
        kind: node?.kind ?? null,
        exists: node !== undefined,
        version: node?.version ?? null,
      },
      page: node?.kind === 'page' ? status(node) : null,
    });
  }

  const names: Record<number, string> = { 0: 'Mario Rossi', 1001: 'Anna Bianchi' };
  const pageUrl = (path: string) =>
    path === '/site/pages/index' ? '/' : path.slice('/site/pages'.length);

  function requirePage(path: unknown): MockNode | MockResult {
    const node = typeof path === 'string' ? nodes.get(path) : undefined;
    if (!node) return fail(404, 'not_found', `Il nodo ${String(path)} non esiste.`);
    return node;
  }

  function addVersion(node: MockNode, body: MockVersion['body']): number {
    const version = (node.versions.at(-1)?.version ?? 0) + 1;
    node.versions.push({ version, body, authorUid: 0, createdAt: new Date().toISOString() });
    return version;
  }

  function pages(req: MockRequest, route: string): MockResult | null {
    switch (route) {
      case 'GET /pages': {
        const path = req.query.get('path') ?? '';
        const node = requirePage(path);
        if ('status' in node) return node;
        const latest = node.versions.at(-1);
        return ok({
          node: { path, url: pageUrl(path), version: node.version },
          status: status(node),
          meta: latest?.body.meta ?? {},
          versions: [...node.versions].reverse().map((v) => ({
            version: v.version,
            authorUid: v.authorUid,
            authorName: names[v.authorUid] ?? null,
            viaAgent: v.version === 2 ? 'content-agent' : null,
            createdAt: v.createdAt,
            published: v.version === node.published,
          })),
        });
      }
      case 'POST /pages': {
        const { parent, name, title } = req.body as Record<string, string>;
        const path = `${parent}/${name}`;
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(name ?? '')) {
          return fail(400, 'invalid', `Nome non valido: "${name}".`);
        }
        if (!nodes.has(parent!)) return fail(404, 'not_found', `Il nodo ${parent} non esiste.`);
        if (nodes.has(path)) return fail(400, 'invalid', `Esiste già un nodo in ${path}.`);
        const node: MockNode = { kind: 'page', version: 1, versions: [], published: null };
        addVersion(node, { meta: title ? { title } : {}, blocks: [] });
        nodes.set(path, node);
        return ok({ path, url: pageUrl(path), version: 1 }, 201);
      }
      case 'PATCH /pages': {
        const node = requirePage(req.body.path);
        if ('status' in node) return node;
        const latest = node.versions.at(-1)?.version ?? 0;
        if (req.body.expectedVersion !== latest) {
          return fail(409, 'conflict', 'Conflitto: la pagina è stata modificata da qualcun altro.');
        }
        const blocks = node.versions.at(-1)?.body.blocks ?? [];
        return ok({ version: addVersion(node, { meta: req.body.meta as never, blocks }) });
      }
      case 'POST /pages/publish': {
        const node = requirePage(req.body.path);
        if ('status' in node) return node;
        node.published = node.versions.at(-1)?.version ?? null;
        return ok({ path: req.body.path, env: req.env, status: 'published' });
      }
      case 'POST /pages/unpublish': {
        const node = requirePage(req.body.path);
        if ('status' in node) return node;
        node.published = null;
        return ok({ path: req.body.path, env: req.env, status: 'archived' });
      }
      case 'POST /pages/restore': {
        const node = requirePage(req.body.path);
        if ('status' in node) return node;
        const source = node.versions.find((v) => v.version === req.body.version);
        if (!source) return fail(404, 'not_found', 'Versione inesistente.');
        return ok({ version: addVersion(node, structuredClone(source.body)) });
      }
      case 'POST /pages/validate': {
        if (req.body.url === '/contatti') {
          return ok({
            status: 'unavailable',
            url: req.body.url,
            message: 'Il sito non è raggiungibile in questo momento: riprova la verifica tra poco.',
          });
        }
        return ok({
          status: 'checked',
          url: req.body.url,
          report: {
            ok: false,
            errors: [
              {
                rule: 'ai-cms/single-h1',
                message: 'La pagina ha 2 titoli <h1>: deve averne esattamente uno.',
                selector: 'main > section:nth-child(2) > h1',
              },
            ],
            warnings: [
              {
                rule: 'ai-cms/meta-description',
                message: 'La descrizione è troppo corta (24 caratteri): ne servono almeno 50.',
              },
            ],
          },
        });
      }
    }
    return null;
  }

  function handle(req: MockRequest): MockResult {
    const route = `${req.method} ${req.path}`;
    const result = pages(req, route);
    if (result) return result;
    switch (route) {
      case 'GET /context':
        return context(req);
      case 'GET /auth/me':
        return ok({ user: ME, env: req.env, csrfToken: 'dev-csrf-token' });
      case 'POST /auth/sso': {
        const url = new URL(String(req.body.returnTo ?? '/'), 'http://localhost/');
        url.searchParams.set('env', String(req.body.target));
        return ok({ url: url.pathname + url.search });
      }
      case 'POST /auth/logout':
        return ok({ ok: true });
    }
    return fail(404, 'not_found', 'Non trovato.');
  }

  return { handle };
}
