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

  function handle(req: MockRequest): MockResult {
    const route = `${req.method} ${req.path}`;
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
