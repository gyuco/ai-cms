import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  BUILDER_CHECKS,
  isChangesetId,
  isCommitId,
  type BuilderCheckName,
  type BuilderRunRequest,
} from '@ai-cms/pipeline/builder';
import { RunConflictError, type RunManager } from './runs.ts';

export interface BuilderServerOptions {
  runs: RunManager;
  /** Shared secret of the worker (`builder_token`). */
  token: string;
  deleteArtifacts: (changesetId: string) => Promise<void>;
}

const MAX_BODY = 1024 * 1024;
const MAX_PAGES = 500;

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return token.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Richiesta troppo grande');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const isPath = (value: unknown): value is string =>
  typeof value === 'string' && /^\/(?!\/)[^\s#]*$/.test(value) && value.length <= 2_000;

/** Validates a `POST /runs` body; returns an Italian error message or the request. */
export function parseRunRequest(body: unknown): BuilderRunRequest | string {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isChangesetId(b.changesetId)) return 'changesetId non valido';
  if (!isCommitId(b.commit)) return 'commit non valido';
  if (typeof b.databaseUrl !== 'string' || !/^postgres(?:ql)?:\/\//.test(b.databaseUrl)) {
    return 'databaseUrl non valido';
  }
  const checks = b.checks;
  if (
    !Array.isArray(checks) ||
    checks.length === 0 ||
    !checks.every((c) => BUILDER_CHECKS.includes(c as BuilderCheckName))
  ) {
    return `checks deve contenere solo: ${BUILDER_CHECKS.join(', ')}`;
  }
  for (const key of ['pages', 'publishedPages'] as const) {
    const list = b[key];
    if (!Array.isArray(list) || list.length > MAX_PAGES || !list.every(isPath)) {
      return `${key} deve essere un elenco di percorsi che iniziano con /`;
    }
  }
  return {
    changesetId: b.changesetId,
    commit: b.commit,
    databaseUrl: b.databaseUrl,
    checks: [...new Set(checks as BuilderCheckName[])],
    pages: b.pages as string[],
    publishedPages: b.publishedPages as string[],
  };
}

/**
 * Internal API of the builder, reachable only on the staging network and only with the
 * worker's token:
 * - `POST /runs` starts the checks of a changeset commit (202; 409 with the active run),
 * - `GET /runs/:id` returns the run and the result of each check so far,
 * - `DELETE /changesets/:id` removes the artifacts of a closed changeset.
 */
export function createBuilderHandler(options: BuilderServerOptions): RequestListener {
  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://builder');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
      if (!authorized(req, options.token)) return send(res, 401, { error: 'Non autorizzato' });

      if (req.method === 'POST' && url.pathname === '/runs') {
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (error) {
          return send(res, 400, { error: `Corpo non valido: ${(error as Error).message}` });
        }
        const request = parseRunRequest(body);
        if (typeof request === 'string') return send(res, 400, { error: request });
        try {
          return send(res, 202, options.runs.start(request));
        } catch (error) {
          if (error instanceof RunConflictError) {
            return send(res, 409, { error: error.message, run: error.run });
          }
          throw error;
        }
      }

      const run = /^\/runs\/([\w-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && run) {
        const found = options.runs.get(run[1]!);
        return found ? send(res, 200, found) : send(res, 404, { error: 'Run non trovato' });
      }

      const changeset = /^\/changesets\/([\w-]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && changeset) {
        if (!isChangesetId(changeset[1])) return send(res, 400, { error: 'Id non valido' });
        await options.deleteArtifacts(changeset[1]);
        return send(res, 204);
      }
      return send(res, 404, { error: 'Non trovato' });
    })().catch((error: unknown) => {
      console.error('builder: request failed', error);
      if (!res.headersSent) send(res, 500, { error: 'Errore interno del builder' });
    });
  };
}
