import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { formatReport, validateDocument } from '@ai-cms/html-rules';

export interface RunningSite {
  /** e.g. `http://127.0.0.1:41234` */
  url: string;
  /** Output of the server so far, to explain a failed start. */
  logs(): string;
  stop(): Promise<void>;
}

/** A free TCP port on the loopback interface. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Nessuna porta libera'));
      });
    });
  });
}

export interface StartSiteOptions {
  /** Absolute path of the standalone `server.js`. */
  server: string;
  env: Record<string, string>;
  startTimeoutMs?: number;
}

/**
 * Starts a Next.js standalone server on a free loopback port and waits until it answers.
 * The server runs in its own process group, killed on `stop()`.
 */
export async function startSite(options: StartSiteOptions): Promise<RunningSite> {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const child = spawn(process.execPath, [options.server], {
    cwd: dirname(options.server),
    env: { ...options.env, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const collect = (chunk: Buffer) => {
    logs = (logs + chunk.toString('utf8')).slice(-16_384);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let exited = false;
  const exit = new Promise<void>((resolve) =>
    child.once('exit', () => {
      exited = true;
      resolve();
    }),
  );
  const stop = async () => {
    if (exited) return;
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, 5_000);
    await exit;
    clearTimeout(timer);
  };

  const deadline = Date.now() + (options.startTimeoutMs ?? 60_000);
  while (!exited) {
    try {
      await fetch(`${url}/`, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
      return { url, logs: () => logs, stop };
    } catch {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await stop();
  throw new Error(
    exited
      ? `Il sito si è fermato durante l'avvio.\n${logs}`
      : `Il sito non risponde dopo ${String(Math.round((options.startTimeoutMs ?? 60_000) / 1000))} s.\n${logs}`,
  );
}

interface Page {
  path: string;
  status: number;
  html: string;
}

async function get(base: string, path: string): Promise<Page> {
  const response = await fetch(`${base}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  return { path, status: response.status, html: await response.text() };
}

const titleOf = (html: string) =>
  /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;

export interface CheckOutcome {
  status: 'passed' | 'failed';
  output: string;
}

/**
 * `e2e` in the MVP: a smoke test over HTTP. Every published page answers 200 and an unknown
 * path answers 404. Playwright on the touched pages comes later (TECHNICAL §8.2).
 */
export async function smokeTest(
  base: string,
  publishedPages: readonly string[],
): Promise<CheckOutcome> {
  const lines = ["Smoke test HTTP (nell'MVP non si usa ancora Playwright):"];
  let failed = false;
  for (const path of publishedPages) {
    try {
      const page = await get(base, path);
      const ok = page.status === 200;
      failed ||= !ok;
      lines.push(`${ok ? '✓' : '✗'} ${path} → ${String(page.status)}${ok ? '' : ' (atteso 200)'}`);
    } catch (error) {
      failed = true;
      lines.push(`✗ ${path} → nessuna risposta (${(error as Error).message})`);
    }
  }
  const missing = `/__ai-cms-pagina-inesistente-${randomBytes(4).toString('hex')}`;
  try {
    const page = await get(base, missing);
    const ok = page.status === 404;
    failed ||= !ok;
    lines.push(
      `${ok ? '✓' : '✗'} pagina inesistente ${missing} → ${String(page.status)}${ok ? '' : ' (atteso 404)'}`,
    );
  } catch (error) {
    failed = true;
    lines.push(`✗ pagina inesistente → nessuna risposta (${(error as Error).message})`);
  }
  return { status: failed ? 'failed' : 'passed', output: lines.join('\n') };
}

/** `html`: the rendered pages follow the HTML rules of TECHNICAL §11. */
export async function validatePages(base: string, paths: readonly string[]): Promise<CheckOutcome> {
  const pages: Page[] = [];
  const lines: string[] = [];
  let failed = false;
  for (const path of paths) {
    try {
      const page = await get(base, path);
      if (page.status !== 200) {
        failed = true;
        lines.push(`${path}: la pagina risponde ${String(page.status)}, attesa 200.`);
      } else pages.push(page);
    } catch (error) {
      failed = true;
      lines.push(`${path}: nessuna risposta (${(error as Error).message}).`);
    }
  }
  for (const page of pages) {
    const otherTitles = pages
      .filter((p) => p !== page)
      .map((p) => titleOf(p.html))
      .filter((t): t is string => t !== null);
    const report = await validateDocument(page.html, { otherTitles });
    failed ||= !report.ok;
    lines.push(`${page.path}: ${formatReport(report)}`);
  }
  return { status: failed ? 'failed' : 'passed', output: lines.join('\n\n') };
}
