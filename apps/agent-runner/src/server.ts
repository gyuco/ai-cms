import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { RunError, type RunnerEvent, type Runner, type RunRequest } from './runner.ts';

/**
 * HTTP API of the agent-runner, reachable only on the `control` network (cms-api and worker):
 *
 * - `POST /runs` `{ token, engine, prompt, resumeSessionId?, messages? }` → NDJSON stream of
 *   events: `run` (with the run id), the engine events, `commit`, and a final `result`;
 * - `POST /runs/:id/cancel` `{ token }` → stops the run;
 * - `POST /cli-auth/status` `{ token }` → whether the user behind the token has linked a
 *   subscription CLI (E8.9): the credentials are never read, only their presence is checked;
 * - `GET /health`.
 *
 * The caller authenticates with the agent session token, which the runner checks with cms-api.
 */

const MAX_BODY_BYTES = 16 * 1024 * 1024;

const runBody = z.object({
  token: z.string().min(1).max(512),
  engine: z.enum(['claude-code', 'native']),
  prompt: z.string().min(1).max(200_000),
  resumeSessionId: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,128}$/)
    .optional(),
  // Validated by the AI gateway in cms-api, which receives them.
  messages: z.array(z.any()).max(10_000).optional(),
});

const cancelBody = z.object({ token: z.string().min(1).max(512) });

// Only the token: the runner answers about the user the token belongs to, never about a
// username the caller chooses.
const cliAuthStatusBody = z.object({ token: z.string().min(1).max(512) });

interface ActiveRun {
  token: string;
  controller: AbortController;
}

class BodyError extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyError('Richiesta troppo grande.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BodyError('JSON non valido.');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createRunnerServer(runner: Runner): Server & { runs: Map<string, ActiveRun> } {
  const runs = new Map<string, ActiveRun>();

  async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = runBody.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(
        res,
        400,
        'bad_request',
        `Richiesta non valida: ${parsed.error.issues[0]?.message ?? ''}`,
      );
      return;
    }
    const request = parsed.data as RunRequest;
    const started = await runner.start(request);

    const runId = randomUUID();
    const controller = new AbortController();
    runs.set(runId, { token: request.token, controller });
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-run-id': runId,
    });
    // The caller hanging up stops the run (the commit of what was done still happens).
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const emit = (event: RunnerEvent) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    emit({ type: 'run', runId });
    try {
      await started.execute(emit, controller.signal);
    } catch (err) {
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      runs.delete(runId);
      res.end();
    }
  }

  function handleCancel(runId: string, body: unknown, res: ServerResponse): void {
    const parsed = cancelBody.safeParse(body);
    const run = runs.get(runId);
    // Same answer for an unknown run and a wrong token.
    if (!parsed.success || !run || !sameToken(run.token, parsed.data.token)) {
      sendError(res, 404, 'not_found', 'Esecuzione non trovata.');
      return;
    }
    run.controller.abort();
    sendJson(res, 202, { cancelled: true });
  }

  async function handleCliAuthStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = cliAuthStatusBody.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(
        res,
        400,
        'bad_request',
        `Richiesta non valida: ${parsed.error.issues[0]?.message ?? ''}`,
      );
      return;
    }
    sendJson(res, 200, await runner.subscriptionStatus(parsed.data.token));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://agent-runner');
    const handle = async () => {
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, runs: runs.size });
      } else if (req.method === 'POST' && url.pathname === '/runs') {
        await handleRun(req, res);
      } else if (req.method === 'POST' && /^\/runs\/[^/]+\/cancel$/.test(url.pathname)) {
        handleCancel(decodeURIComponent(url.pathname.split('/')[2]!), await readJson(req), res);
      } else if (req.method === 'POST' && url.pathname === '/cli-auth/status') {
        await handleCliAuthStatus(req, res);
      } else {
        sendError(res, 404, 'not_found', 'Risorsa non trovata.');
      }
    };
    handle().catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
      } else if (err instanceof RunError) {
        sendError(res, err.status, err.code, err.message);
      } else if (err instanceof BodyError) {
        sendError(res, 400, 'bad_request', err.message);
      } else {
        console.error('agent-runner: request failed', err);
        sendError(res, 500, 'internal', "Errore interno dell'agent-runner.");
      }
    });
  });
  return Object.assign(server, { runs });
}
