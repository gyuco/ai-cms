import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changesetIdFromHost, readPreviewConfig } from './config.ts';
import { createLauncher, PreviewManager, type LaunchOptions, type SiteProcess } from './manager.ts';
import { createPreviewHandler, HEALTH_PATH } from './server.ts';

const ID = '0b5c7a4e-9d1f-4c3a-8e2b-1f2a3b4c5d6e';
const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);

describe('changesetIdFromHost', () => {
  it('routes cs-<id>.localhost only', () => {
    expect(changesetIdFromHost(`cs-${ID}.localhost`)).toBe(ID);
    expect(changesetIdFromHost(`CS-${ID.toUpperCase()}.localhost:80`)).toBe(ID);
    expect(changesetIdFromHost(`cs-${ID}.localhost.`)).toBe(ID);
    expect(changesetIdFromHost('www.localhost')).toBeNull();
    expect(changesetIdFromHost('cs-123.localhost')).toBeNull();
    expect(changesetIdFromHost(`cs-${ID}.example.com`)).toBeNull();
    expect(changesetIdFromHost(`x.cs-${ID}.localhost`)).toBeNull();
    expect(changesetIdFromHost(undefined)).toBeNull();
  });
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-cms-previews-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writePreview(commit: string, extra: Record<string, unknown> = {}) {
  await mkdir(join(root, ID, commit), { recursive: true });
  await writeFile(
    join(root, ID, 'preview.json'),
    JSON.stringify({
      changesetId: ID,
      commit,
      artifact: commit,
      server: 'templates/site/server.js',
      env: { DATABASE_URL: 'postgres://site_app@x/app_cs', SECRET: 'no' },
      builtAt: '2026-01-01T00:00:00Z',
      ...extra,
    }),
  );
}

describe('readPreviewConfig', () => {
  it('keeps only the allowed environment', async () => {
    await writePreview(C1);
    expect(await readPreviewConfig(root, ID)).toEqual({
      changesetId: ID,
      commit: C1,
      artifact: C1,
      server: 'templates/site/server.js',
      env: { DATABASE_URL: 'postgres://site_app@x/app_cs' },
      builtAt: '2026-01-01T00:00:00Z',
    });
  });

  it('rejects paths outside the changeset directory and foreign ids', async () => {
    for (const bad of [
      { server: '../../x.js' },
      { server: '/etc/x.js' },
      { artifact: '../other' },
      { changesetId: '1b5c7a4e-9d1f-4c3a-8e2b-1f2a3b4c5d6e' },
      { commit: 'HEAD' },
    ]) {
      await writePreview(C1, bad);
      expect(await readPreviewConfig(root, ID)).toBeNull();
    }
    expect(await readPreviewConfig(root, 'x')).toBeNull();
    expect(await readPreviewConfig(root, '1b5c7a4e-9d1f-4c3a-8e2b-1f2a3b4c5d6e')).toBeNull();
  });
});

/** A launcher that resolves on demand, recording what it started and stopped. */
function fakeLauncher() {
  const launches: LaunchOptions[] = [];
  const stopped: number[] = [];
  const pending: Array<{ resolve: (p: SiteProcess) => void; reject: (e: Error) => void }> = [];
  const exits: Array<() => void> = [];
  let nextPort = 5000;
  return {
    launches,
    stopped,
    launch: (options: LaunchOptions) =>
      new Promise<SiteProcess>((resolve, reject) => {
        launches.push(options);
        pending.push({ resolve, reject });
      }),
    succeed() {
      const port = nextPort++;
      let exit!: () => void;
      const exited = new Promise<void>((r) => (exit = r));
      exits.push(exit);
      pending.shift()!.resolve({
        port,
        exited,
        stop: async () => {
          stopped.push(port);
          exit();
        },
      });
      return port;
    },
    fail(message: string) {
      pending.shift()!.reject(new Error(message));
    },
    crash() {
      exits.shift()!();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('PreviewManager', () => {
  it('starts on demand, reuses the process and restarts on a newer artifact', async () => {
    await writePreview(C1);
    const l = fakeLauncher();
    const manager = new PreviewManager({
      artifactsRoot: root,
      launch: l.launch,
      baseEnv: { PATH: '/bin' },
    });
    expect(await manager.resolve(ID)).toEqual({ state: 'starting', commit: C1 });
    expect(await manager.resolve(ID)).toEqual({ state: 'starting', commit: C1 });
    expect(l.launches).toEqual([
      {
        artifactDir: join(root, ID, C1),
        server: 'templates/site/server.js',
        env: { PATH: '/bin', DATABASE_URL: 'postgres://site_app@x/app_cs', CMS_ENV: 'staging' },
      },
    ]);
    const port = l.succeed();
    await tick();
    expect(await manager.resolve(ID)).toEqual({ state: 'ready', commit: C1, port });

    await writePreview(C2);
    expect(await manager.resolve(ID)).toEqual({ state: 'starting', commit: C2 });
    expect(l.stopped).toEqual([port]);
    expect(l.launches).toHaveLength(2);
  });

  it('stops idle previews and previews whose artifacts were removed', async () => {
    await writePreview(C1);
    let now = 0;
    const l = fakeLauncher();
    const manager = new PreviewManager({
      artifactsRoot: root,
      launch: l.launch,
      idleMs: 1_000,
      now: () => now,
    });
    await manager.resolve(ID);
    const port = l.succeed();
    await tick();
    now = 500;
    await manager.reap();
    expect(manager.active()).toEqual([ID]);
    now = 1_600;
    await manager.reap();
    expect(manager.active()).toEqual([]);
    expect(l.stopped).toEqual([port]);

    await manager.resolve(ID);
    const second = l.succeed();
    await tick();
    await rm(join(root, ID), { recursive: true });
    await manager.reap();
    expect(l.stopped).toEqual([port, second]);
    expect(await manager.resolve(ID)).toEqual({ state: 'missing' });
  });

  it('reports a failed start, then retries later', async () => {
    await writePreview(C1);
    let now = 0;
    const l = fakeLauncher();
    const manager = new PreviewManager({
      artifactsRoot: root,
      launch: l.launch,
      retryMs: 1_000,
      now: () => now,
    });
    await manager.resolve(ID);
    l.fail('manca DATABASE_URL');
    await tick();
    expect(await manager.resolve(ID)).toEqual({
      state: 'failed',
      commit: C1,
      error: 'manca DATABASE_URL',
    });
    now = 2_000;
    expect(await manager.resolve(ID)).toEqual({ state: 'starting', commit: C1 });
    expect(l.launches).toHaveLength(2);
  });

  it('forgets a process that exits by itself', async () => {
    await writePreview(C1);
    const l = fakeLauncher();
    const manager = new PreviewManager({ artifactsRoot: root, launch: l.launch });
    await manager.resolve(ID);
    l.succeed();
    await tick();
    l.crash();
    await tick();
    expect(manager.active()).toEqual([]);
    expect(await manager.resolve(ID)).toEqual({ state: 'starting', commit: C1 });
  });
});

describe('preview proxy', () => {
  let site: Server;
  let proxy: Server | undefined;
  let sitePort: number;

  beforeEach(async () => {
    site = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-site': '1' });
      res.end(
        `${req.method} ${req.url} host=${req.headers.host} fwd=${String(req.headers['x-forwarded-host'])}`,
      );
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    sitePort = (site.address() as AddressInfo).port;
  });
  afterEach(() => {
    site.close();
    proxy?.close();
  });

  async function start(manager: PreviewManager) {
    const handler = createPreviewHandler(manager);
    proxy = createServer(handler.request);
    proxy.on('upgrade', handler.upgrade);
    await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
    const port = (proxy.address() as AddressInfo).port;
    return (path: string, host: string) =>
      new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
        (resolve, reject) => {
          // fetch() cannot override Host: use a raw request.
          const req = request(
            { host: '127.0.0.1', port, path, headers: { host } },
            (res: IncomingMessage) => {
              let body = '';
              res.on('data', (c: Buffer) => (body += c.toString()));
              res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
            },
          );
          req.on('error', reject);
          req.end();
        },
      );
  }

  it('routes by host through the waiting page to the site', async () => {
    await writePreview(C1);
    const launch = async (): Promise<SiteProcess> => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { port: sitePort, exited: new Promise(() => {}), stop: async () => {} };
    };
    const get = await start(new PreviewManager({ artifactsRoot: root, launch }));
    const host = `cs-${ID}.localhost`;

    expect((await get(HEALTH_PATH, 'localhost')).status).toBe(200);
    expect((await get('/', 'www.localhost')).status).toBe(404);
    expect((await get('/', `cs-1b5c7a4e-9d1f-4c3a-8e2b-1f2a3b4c5d6e.localhost`)).status).toBe(404);

    const waiting = await get('/', host);
    expect(waiting.status).toBe(503);
    expect(waiting.body).toContain('Anteprima in avvio…');
    expect(waiting.headers['retry-after']).toBe('2');

    let page = await get('/prenota?x=1', host);
    for (let i = 0; i < 100 && page.status === 503; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      page = await get('/prenota?x=1', host);
    }
    expect(page.status).toBe(200);
    expect(page.headers['x-site']).toBe('1');
    expect(page.body).toBe(`GET /prenota?x=1 host=${host} fwd=${host}`);
  });

  it('shows the start error', async () => {
    await writePreview(C1);
    const launch = async (): Promise<SiteProcess> => {
      throw new Error('<boom>');
    };
    const get = await start(new PreviewManager({ artifactsRoot: root, launch }));
    await get('/', `cs-${ID}.localhost`);
    await tick();
    const failed = await get('/', `cs-${ID}.localhost`);
    expect(failed.status).toBe(502);
    expect(failed.body).toContain('&#60;boom&#62;');
  });
});

describe('createLauncher', () => {
  const runRoot = join(tmpdir(), `ai-cms-previews-run-${String(process.pid)}`);
  afterAll(async () => {
    await rm(runRoot, { recursive: true, force: true });
  });

  it('runs a private copy of the artifact and removes it on stop', async () => {
    const artifact = join(root, ID, C1);
    await mkdir(join(artifact, 'templates', 'site'), { recursive: true });
    await writeFile(
      join(artifact, 'templates', 'site', 'server.js'),
      `require('fs').writeFileSync(__dirname + '/cache', 'x');
       require('http').createServer((q, s) => s.end(process.env.DATABASE_URL + ' ' + process.cwd())).listen(Number(process.env.PORT), process.env.HOSTNAME);`,
    );
    const launch = createLauncher({ runRoot });
    const site = await launch({
      artifactDir: artifact,
      server: 'templates/site/server.js',
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgres://cs' },
    });
    const body = await (await fetch(`http://127.0.0.1:${String(site.port)}/`)).text();
    expect(body.startsWith('postgres://cs ')).toBe(true);
    expect(body).toContain(runRoot);
    expect(await readdir(runRoot)).toHaveLength(1);
    await site.stop();
    await site.exited;
    expect(await readdir(runRoot)).toHaveLength(0);
  });
});
