import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createMockState, type MockRequest, type MockResult } from './mock-state.ts';

/**
 * Dev-server only: a fake `/_cms/api` for dev/index.html, so the widget can be tried without
 * cms-api and a database. The page URL chooses the scenario: `?env=staging` for the staging
 * environment, `?anon` for a visitor without a session (401). The state lives in memory;
 * `POST /_cms/api/__reset` (or a restart) brings it back to the initial data.
 */
export function devApiMock(): Plugin {
  let state = createMockState();
  return {
    name: 'cms-widget-dev-api',
    configureServer(server) {
      // Any other page URL (e.g. /chi-siamo, reached from the Site tab) shows the test page.
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? '/').split('?')[0]!;
        const isPage = /^\/(?!_cms\/|@|src\/|dev\/|node_modules\/)[a-z0-9/_-]*$/.test(path);
        if (req.method === 'GET' && isPage && path !== '/') {
          req.url = `/dev/index.html${(req.url ?? '').slice(path.length)}`;
        }
        next();
      });
      server.middlewares.use('/_cms/api', (req: IncomingMessage, res: ServerResponse) => {
        const page = new URL(req.headers.referer ?? 'http://localhost/', 'http://localhost/');
        const env = page.searchParams.get('env') === 'staging' ? 'staging' : 'prod';
        const send = ({ status, body }: MockResult) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };

        if (page.searchParams.has('anon')) {
          return send({
            status: 401,
            body: { error: { code: 'unauthenticated', message: 'Accesso richiesto.' } },
          });
        }
        const method = req.method ?? 'GET';
        if (method !== 'GET' && req.headers['x-csrf-token'] !== 'dev-csrf-token') {
          return send({
            status: 403,
            body: { error: { code: 'csrf', message: 'Richiesta non valida.' } },
          });
        }
        let raw = '';
        req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        req.on('end', () => {
          const url = new URL(req.url ?? '/', 'http://localhost/');
          if (url.pathname === '/__reset') {
            state = createMockState();
            return send({ status: 200, body: { ok: true } });
          }
          const request: MockRequest = {
            method,
            path: url.pathname,
            query: url.searchParams,
            body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
            env,
          };
          // A short delay makes loading states visible.
          setTimeout(() => send(state.handle(request)), 150);
        });
      });
    },
  };
}
