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

  let settings = { name: 'Studio Rossi', lang: 'it', titleTemplate: '%s · Studio Rossi' };
  let settingsVersion = 3;
  const shared = (path: string, latest: number | null, published: number | null) => ({
    name: path.split('/').at(-1),
    path,
    status: {
      latestVersion: latest,
      publishedVersion: published,
      hasDraft: latest !== null && latest !== published,
    },
  });
  const childrenOf = (parent: string) =>
    [...nodes.keys()]
      .filter(
        (path) => path.startsWith(`${parent}/`) && !path.slice(parent.length + 1).includes('/'),
      )
      .sort();

  function relocate(from: string, to: string): MockResult | null {
    if (nodes.has(to)) return fail(400, 'invalid', `Esiste già un nodo in ${to}.`);
    for (const path of [...nodes.keys()]) {
      if (path === from || path.startsWith(`${from}/`)) {
        const node = nodes.get(path)!;
        nodes.delete(path);
        node.version++;
        nodes.set(to + path.slice(from.length), node);
      }
    }
    return null;
  }

  function site(req: MockRequest, route: string): MockResult | null {
    switch (route) {
      case 'GET /tree': {
        const parent = req.query.get('path') ?? '/site/pages';
        if (!nodes.has(parent)) return fail(404, 'not_found', `Il nodo ${parent} non esiste.`);
        return ok({
          entries: childrenOf(parent).map((path) => {
            const node = nodes.get(path)!;
            const title = node.versions.at(-1)?.body.meta.title;
            return {
              path,
              name: path.split('/').at(-1),
              kind: node.kind,
              url: pageUrl(path),
              title: typeof title === 'string' ? title : null,
              hasChildren: childrenOf(path).length > 0,
              version: node.version,
              status: status(node),
            };
          }),
        });
      }
      case 'POST /pages/rename': {
        const path = String(req.body.path);
        const to = `${path.slice(0, path.lastIndexOf('/'))}/${String(req.body.name)}`;
        return relocate(path, to) ?? ok({ path: to });
      }
      case 'POST /pages/move': {
        const path = String(req.body.path);
        if (!nodes.has(String(req.body.parent))) {
          return fail(404, 'not_found', `Il nodo ${String(req.body.parent)} non esiste.`);
        }
        const to = `${String(req.body.parent)}/${path.split('/').at(-1)}`;
        return relocate(path, to) ?? ok({ path: to });
      }
      case 'POST /pages/delete': {
        const path = String(req.body.path);
        for (const key of [...nodes.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) nodes.delete(key);
        }
        return ok({ path, hookError: 'il sito non è raggiungibile per la rigenerazione' });
      }
      case 'GET /site':
        return ok({
          settings: {
            value: settings,
            version: settingsVersion,
            status: {
              latestVersion: settingsVersion,
              publishedVersion: settingsVersion,
              hasDraft: false,
            },
          },
          layouts: [shared('/site/layouts/footer', 2, 2), shared('/site/layouts/header', 3, 2)],
          menus: [shared('/site/menus/main', 1, 1)],
        });
      case 'PUT /site': {
        const next = req.body.settings as typeof settings;
        if (!next.titleTemplate.includes('%s')) {
          return fail(400, 'invalid', 'Il modello del titolo deve contenere "%s".');
        }
        settings = next;
        return ok({ version: ++settingsVersion });
      }
    }
    return null;
  }

  const users = [
    {
      uid: 0,
      username: 'root',
      displayName: 'Mario Rossi',
      email: 'root@example.test',
      status: 'active',
    },
    {
      uid: 1001,
      username: 'anna',
      displayName: 'Anna Bianchi',
      email: 'anna@studio.test',
      status: 'active',
    },
    {
      uid: 1002,
      username: 'luca',
      displayName: null,
      email: 'luca@studio.test',
      status: 'invited',
    },
    {
      uid: 1003,
      username: 'giulia',
      displayName: 'Giulia Verdi',
      email: 'giulia@studio.test',
      status: 'suspended',
    },
  ];

  function people(req: MockRequest, route: string): MockResult | null {
    if (route === 'GET /users') return ok({ users });
    if (route === 'POST /users/invite') {
      const { username, email, displayName } = req.body as Record<string, string>;
      if (users.some((u) => u.username === username || u.email === email)) {
        return fail(400, 'exists', 'Esiste già un utente con questo nome o questa email.');
      }
      users.push({
        uid: 1000 + users.length + 1,
        username: username!,
        email: email!,
        displayName: displayName || null,
        status: 'invited',
      });
      return ok({ uid: 1000 + users.length }, 201);
    }
    const match = /^POST \/users\/(\d+)\/(suspend|reactivate)$/.exec(route);
    if (!match) return null;
    const user = users.find((u) => u.uid === Number(match[1]));
    if (!user) return fail(404, 'not_found', 'Utente non trovato.');
    if (match[2] === 'suspend') {
      if (user.uid === 0) return fail(403, 'root', "L'utente root non si può sospendere.");
      user.status = 'suspended';
    } else {
      user.status = 'active';
    }
    return ok({ status: user.status });
  }

  interface MockConnection {
    id: string;
    label: string;
    type: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    scope: string;
    ownerUid: number | null;
    hasKey: boolean;
    keyHint: string | null;
    lastTest: { model: string; ok: boolean; tools: boolean; at: string } | null;
  }
  const connections: MockConnection[] = [
    {
      id: 'anthropic',
      label: 'Anthropic dello studio',
      type: 'api',
      provider: 'anthropic',
      baseUrl: null,
      defaultModel: 'claude-sonnet-4-5',
      scope: 'shared',
      ownerUid: null,
      hasKey: true,
      keyHint: 'sk-ant-…Q2xA',
      lastTest: { model: 'claude-sonnet-4-5', ok: true, tools: true, at: hoursAgo(5) },
    },
    {
      id: 'claude-code',
      label: 'Claude Code di Mario',
      type: 'subscription',
      provider: 'claude-code',
      baseUrl: null,
      defaultModel: null,
      scope: 'shared',
      ownerUid: null,
      hasKey: false,
      keyHint: null,
      lastTest: null,
    },
  ];
  let active = 'anthropic';
  const ROLES = ['content-agent', 'dev-agent', 'ai-review', 'translate', 'alt-text'];

  function ai(req: MockRequest, route: string): MockResult | null {
    if (route === 'GET /ai/connections') {
      return ok({
        connections,
        roles: ROLES.map((role) => ({ role, connectionId: active, model: null })),
      });
    }
    if (route === 'POST /ai/connections') {
      const body = req.body as Record<string, string | undefined>;
      const id = (body.label ?? 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (body.type === 'api' && !body.apiKey) {
        return fail(400, 'invalid_input', 'Per una connessione con chiave API serve la chiave.');
      }
      const connection: MockConnection = {
        id,
        label: body.label ?? '',
        type: body.type ?? 'api',
        provider: body.provider ?? 'anthropic',
        baseUrl: body.baseUrl ?? null,
        defaultModel: body.defaultModel ?? null,
        scope: body.scope ?? 'shared',
        ownerUid: body.scope === 'personal' ? 0 : null,
        hasKey: Boolean(body.apiKey),
        keyHint: body.apiKey ? `${body.apiKey.slice(0, 3)}…${body.apiKey.slice(-4)}` : null,
        lastTest: null,
      };
      connections.push(connection);
      return ok({ connection }, 201);
    }
    if (route === 'POST /ai/active') {
      active = String(req.body.connectionId);
      return ok({ connectionId: active, model: null, roles: ROLES });
    }
    const match = /^(PATCH|DELETE|POST) \/ai\/connections\/([^/]+)(\/test)?$/.exec(route);
    if (!match) return null;
    const connection = connections.find((c) => c.id === decodeURIComponent(match[2]!));
    if (!connection) return fail(404, 'not_found', 'Connessione inesistente.');
    if (match[3]) {
      if (connection.provider === 'claude-code') {
        return ok({
          ok: true,
          status: 'unverified',
          model: null,
          tools: true,
          latencyMs: 0,
          message:
            "Claude Code gira nell'agent-runner: la verifica avviene alla prima conversazione. Collega l'abbonamento con make connect-claude-code.",
        });
      }
      connection.lastTest = {
        model: connection.defaultModel ?? '',
        ok: true,
        tools: true,
        at: new Date().toISOString(),
      };
      return ok({
        ok: true,
        status: 'ok',
        model: connection.defaultModel,
        tools: true,
        latencyMs: 812,
        message: `Connessione riuscita con ${String(connection.defaultModel)} (0,8 s), uso di strumenti verificato.`,
      });
    }
    if (match[1] === 'DELETE') {
      connections.splice(connections.indexOf(connection), 1);
      return ok({ ok: true });
    }
    if (typeof req.body.apiKey === 'string') {
      connection.hasKey = true;
      connection.keyHint = `…${req.body.apiKey.slice(-4)}`;
    }
    return ok({ connection });
  }

  const samples = [
    {
      action: 'content.write',
      nodePath: '/site/pages/chi-siamo',
      outcome: 'ok',
      agent: 'content-agent',
    },
    { action: 'content.publish', nodePath: '/site/pages/chi-siamo', outcome: 'ok', agent: null },
    { action: 'auth.login', nodePath: null, outcome: 'ok', agent: null },
    {
      action: 'node.create',
      nodePath: '/site/pages/progetti/casa-sul-lago',
      outcome: 'ok',
      agent: null,
    },
    {
      action: 'content.write',
      nodePath: '/code/api/prodotti',
      outcome: 'denied',
      agent: 'content-agent',
    },
    { action: 'ai.active.set', nodePath: '/system/ai/roles', outcome: 'ok', agent: null },
    { action: 'user.invite', nodePath: null, outcome: 'ok', agent: null },
  ];
  const auditLog = Array.from({ length: 120 }, (_, i) => {
    const sample = samples[i % samples.length]!;
    return {
      id: i + 1,
      at: hoursAgo((120 - i) * 3),
      actorUid: i % 3 === 0 ? 1001 : 0,
      actor: i % 3 === 0 ? 'anna' : 'root',
      agent: sample.agent,
      action: sample.action,
      nodePath: sample.nodePath,
      env: i % 4 === 0 ? 'staging' : 'prod',
      outcome: sample.outcome,
      details:
        sample.outcome === 'denied'
          ? {
              permission: 'write',
              code: 'invariant-I1',
              message: 'Il codice non si modifica in produzione.',
            }
          : sample.action === 'content.write'
            ? { version: i, nodeId: 'n-1' }
            : null,
    };
  }).reverse();

  function audit(req: MockRequest): MockResult {
    const q = (key: string) => req.query.get(key) ?? '';
    const cursor = Number(q('cursor')) || Infinity;
    const to = q('to') ? new Date(q('to')).getTime() + 86_400_000 : Infinity;
    const from = q('from') ? new Date(q('from')).getTime() : -Infinity;
    const matches = auditLog.filter(
      (e) =>
        e.id < cursor &&
        (!q('actor') || e.actor === q('actor')) &&
        e.action.startsWith(q('action')) &&
        (!q('path') || (e.nodePath ?? '').startsWith(q('path'))) &&
        (!q('outcome') || e.outcome === q('outcome')) &&
        new Date(e.at).getTime() >= from &&
        new Date(e.at).getTime() < to,
    );
    const entries = matches.slice(0, 50);
    return ok({ entries, nextCursor: matches.length > 50 ? entries.at(-1)!.id : null });
  }

  function handle(req: MockRequest): MockResult {
    const route = `${req.method} ${req.path}`;
    if (route === 'GET /audit') return audit(req);
    const result = pages(req, route) ?? site(req, route) ?? people(req, route) ?? ai(req, route);
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
