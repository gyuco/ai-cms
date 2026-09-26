import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand, siteEnv } from './exec.ts';
import { smokeTest, startSite, validatePages } from './site-server.ts';

const page = (title: string, body: string) =>
  `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="Una descrizione abbastanza lunga per la pagina di prova del sito, utile ai motori di ricerca."></head><body>${body}</body></html>`;

describe('smokeTest and validatePages', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const pages: Record<string, string> = {
        '/': page('Home', '<header></header><main><h1>Home</h1></main><footer></footer>'),
        '/prenota': page('Prenota', '<main><h1>Prenota</h1><h3>Salto</h3></main>'),
        '/doppio': page('Home', '<main><h1>Altra</h1></main>'),
      };
      const html = pages[req.url ?? ''];
      res.writeHead(html ? 200 : req.url === '/errore' ? 500 : 404, {
        'content-type': 'text/html',
      });
      res.end(html ?? 'no');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(() => server.close());

  it('checks published pages and the 404 page', async () => {
    const ok = await smokeTest(base, ['/', '/prenota']);
    expect(ok.status).toBe('passed');
    expect(ok.output).toMatch(/✓ \/prenota → 200/);
    expect(ok.output).toMatch(/✓ pagina inesistente .* → 404/);
    const ko = await smokeTest(base, ['/', '/errore']);
    expect(ko.status).toBe('failed');
    expect(ko.output).toContain('✗ /errore → 500 (atteso 200)');
  });

  it('validates the HTML of the pages', async () => {
    const ok = await validatePages(base, ['/']);
    expect(ok.status).toBe('passed');
    const ko = await validatePages(base, ['/', '/prenota', '/doppio', '/manca']);
    expect(ko.status).toBe('failed');
    expect(ko.output).toContain('/manca: la pagina risponde 404');
    expect(ko.output).toMatch(/\/prenota: Regole HTML: \d+ error/);
    expect(ko.output).toMatch(/\/doppio: [\s\S]*page-title/);
  });
});

describe('startSite', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-site-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts a standalone server on a free port and stops it', async () => {
    const server = join(dir, 'server.js');
    await writeFile(
      server,
      `require('http').createServer((q, s) => s.end(process.env.DATABASE_URL)).listen(Number(process.env.PORT), process.env.HOSTNAME);`,
    );
    const site = await startSite({ server, env: siteEnv(dir, { DATABASE_URL: 'postgres://cs' }) });
    expect(await (await fetch(`${site.url}/`)).text()).toBe('postgres://cs');
    await site.stop();
    await expect(fetch(`${site.url}/`)).rejects.toThrow();
  });

  it('reports a server that exits during start', async () => {
    const server = join(dir, 'crash.js');
    await writeFile(server, `console.error('manca DATABASE_URL'); process.exit(1);`);
    await expect(startSite({ server, env: siteEnv(dir) })).rejects.toThrow(
      /si è fermato durante l'avvio[\s\S]*manca DATABASE_URL/,
    );
  });
});

describe('runCommand', () => {
  it('returns the exit code and the output', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'console.log("ciao"); process.exit(3)'],
      {
        cwd: tmpdir(),
        env: siteEnv(tmpdir()),
        timeoutMs: 10_000,
      },
    );
    expect(result).toEqual({ code: 3, output: 'ciao\n', timedOut: false });
  });

  it('kills a command after its timeout', async () => {
    const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: tmpdir(),
      env: siteEnv(tmpdir()),
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.output).toMatch(/tempo massimo/);
  });

  it('bounds the output', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("A" + "x".repeat(300000) + "Z")'],
      { cwd: tmpdir(), env: siteEnv(tmpdir()), timeoutMs: 10_000, maxOutput: 4_096 },
    );
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(4_096);
    expect(result.output.startsWith('A')).toBe(true);
    expect(result.output.endsWith('Z')).toBe(true);
  });

  it('builds a clean environment for site commands', () => {
    const env = siteEnv(
      '/w/home',
      { DATABASE_URL: 'x' },
      {
        PATH: '/bin',
        BUILDER_TOKEN: 't',
        HTTPS_PROXY: 'http://egress-proxy:3128',
        PNPM_STORE_DIR: '/pnpm-store',
      },
    );
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/w/home',
      TMPDIR: '/w/home',
      CI: '1',
      NEXT_TELEMETRY_DISABLED: '1',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      HTTPS_PROXY: 'http://egress-proxy:3128',
      npm_config_store_dir: '/pnpm-store',
      DATABASE_URL: 'x',
    });
  });
});
