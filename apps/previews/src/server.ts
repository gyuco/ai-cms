import {
  request as httpRequest,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { changesetIdFromHost } from './config.ts';
import type { PreviewManager } from './manager.ts';

export const HEALTH_PATH = '/__previews/health';

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

function page(title: string, message: string, refresh = false): string {
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="2">\n' : ''}<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#222;background:#fafafa}main{max-width:40rem;padding:2rem}pre{white-space:pre-wrap;font-size:.8rem;background:#eee;padding:1rem}</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${message}</main></body>
</html>
`;
}

function sendPage(
  res: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(html);
}

/** Headers of a proxied request: the original host stays visible to the site. */
function forwardHeaders(req: IncomingMessage): Record<string, string | string[] | undefined> {
  return {
    ...req.headers,
    'x-forwarded-host': req.headers['x-forwarded-host'] ?? req.headers.host,
    'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'http',
  };
}

/**
 * Reverse proxy of the changeset previews: `cs-<id>.localhost` goes to the `next start` process
 * of that changeset, started on demand; while it starts, a waiting page reloads itself.
 */
export function createPreviewHandler(manager: PreviewManager): {
  request: RequestListener;
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
} {
  const request: RequestListener = (req, res) => {
    void (async () => {
      if (req.url === HEALTH_PATH) {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      const id = changesetIdFromHost(req.headers.host);
      if (!id) {
        return sendPage(
          res,
          404,
          page(
            'Anteprima non trovata',
            '<p>Questo indirizzo non corrisponde a nessun changeset.</p>',
          ),
        );
      }
      const preview = await manager.resolve(id);
      switch (preview.state) {
        case 'missing':
          return sendPage(
            res,
            404,
            page(
              'Nessuna anteprima',
              '<p>Questo changeset non ha ancora una build riuscita, oppure è stato chiuso. L’anteprima appare dopo i controlli.</p>',
            ),
          );
        case 'starting':
          return sendPage(
            res,
            503,
            page(
              'Anteprima in avvio…',
              '<p>Il sito del changeset si sta avviando. La pagina si aggiorna da sola.</p>',
              true,
            ),
            { 'retry-after': '2' },
          );
        case 'failed':
          return sendPage(
            res,
            502,
            page(
              'Anteprima non disponibile',
              `<p>Il sito del changeset non si è avviato. Riprova tra poco.</p><pre>${escapeHtml(preview.error)}</pre>`,
            ),
          );
        case 'ready': {
          const upstream = httpRequest(
            {
              host: '127.0.0.1',
              port: preview.port,
              method: req.method,
              path: req.url,
              headers: forwardHeaders(req),
            },
            (response) => {
              res.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
              response.pipe(res);
            },
          );
          upstream.on('error', (error) => {
            if (!res.headersSent) {
              sendPage(
                res,
                502,
                page('Anteprima non disponibile', `<p>${escapeHtml(error.message)}</p>`),
              );
            } else res.destroy();
          });
          req.pipe(upstream);
          return;
        }
      }
    })().catch((error: unknown) => {
      console.error('previews: request failed', error);
      if (!res.headersSent)
        sendPage(res, 500, page('Errore', '<p>Errore interno delle anteprime.</p>'));
      else res.destroy();
    });
  };

  // WebSocket and other upgrades go straight to a running preview.
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const id = changesetIdFromHost(req.headers.host);
    if (!id) return socket.destroy();
    void manager.resolve(id).then(
      (preview) => {
        if (preview.state !== 'ready') return socket.destroy();
        const upstream = connect(preview.port, '127.0.0.1', () => {
          const headers = Object.entries(forwardHeaders(req)).flatMap(([name, value]) =>
            value === undefined
              ? []
              : (Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}`),
          );
          upstream.write(
            `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`,
          );
          upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        const close = () => {
          upstream.destroy();
          socket.destroy();
        };
        upstream.on('error', close);
        socket.on('error', close);
      },
      () => socket.destroy(),
    );
  };

  return { request, upgrade };
}
