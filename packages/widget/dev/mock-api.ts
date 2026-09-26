import type { Plugin } from 'vite';

/**
 * Dev-server only: a fake `/_cms/api` for dev/index.html, so the widget can be tried without
 * cms-api and a database. The page URL chooses the scenario: `?env=staging` for the staging
 * environment, `?anon` for a visitor without a session (401).
 */
export function devApiMock(): Plugin {
  return {
    name: 'cms-widget-dev-api',
    configureServer(server) {
      server.middlewares.use('/_cms/api', (req, res) => {
        const page = new URL(req.headers.referer ?? 'http://localhost/', 'http://localhost/');
        const env = page.searchParams.get('env') === 'staging' ? 'staging' : 'prod';
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };

        if (page.searchParams.has('anon')) {
          return send(401, { error: { code: 'unauthenticated', message: 'Accesso richiesto.' } });
        }
        if (req.url === '/auth/me' && req.method === 'GET') {
          return send(200, {
            user: {
              uid: 0,
              username: 'root',
              displayName: 'Mario Rossi',
              email: 'root@example.test',
              mustChangePassword: false,
            },
            env,
            csrfToken: 'dev-csrf-token',
          });
        }
        if (req.headers['x-csrf-token'] !== 'dev-csrf-token') {
          return send(403, { error: { code: 'csrf', message: 'Richiesta non valida.' } });
        }
        if (req.url === '/auth/sso' && req.method === 'POST') {
          let raw = '';
          req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
          req.on('end', () => {
            const { target, returnTo } = JSON.parse(raw) as { target: string; returnTo: string };
            const url = new URL(returnTo, 'http://localhost/');
            url.searchParams.set('env', target);
            send(200, { url: url.pathname + url.search });
          });
          return;
        }
        if (req.url === '/auth/logout' && req.method === 'POST') {
          return send(200, { ok: true });
        }
        send(404, { error: { code: 'not_found', message: 'Non trovato.' } });
      });
    },
  };
}
