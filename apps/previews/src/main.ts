import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentDatabaseUrl } from '@ai-cms/pipeline/builder';
import { createLauncher, PreviewManager } from './manager.ts';
import { createPreviewHandler } from './server.ts';

/**
 * Service variables a preview inherits (never platform secrets). Extra names
 * can be listed in PREVIEW_PASSTHROUGH_ENV, comma-separated.
 */
const BASE_ENV = [
  'PATH',
  'TZ',
  'LANG',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
];

const names = [
  ...BASE_ENV,
  ...(process.env.PREVIEW_PASSTHROUGH_ENV ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),
];
const baseEnv = Object.fromEntries(
  names.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])),
);
const runRoot = process.env.PREVIEWS_RUN_ROOT || join(tmpdir(), 'ai-cms-previews');
baseEnv.HOME = runRoot;
baseEnv.NEXT_TELEMETRY_DISABLED = '1';
// Read-only access to published content (public data), so previews show real pages.
const contentUrl = contentDatabaseUrl();
if (contentUrl) baseEnv.CORE_DATABASE_URL = contentUrl;

const manager = new PreviewManager({
  artifactsRoot: process.env.ARTIFACTS_ROOT || '/data/artifacts',
  launch: createLauncher({ runRoot }),
  baseEnv,
  idleMs: Number(process.env.PREVIEW_IDLE_MS ?? 15 * 60_000),
  log: (message) => console.log(`previews: ${message}`),
});

const handler = createPreviewHandler(manager);
const server = createServer(handler.request);
server.on('upgrade', handler.upgrade);

const reaper = setInterval(() => void manager.reap(), 60_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`previews: ${signal}, stopping`);
    clearInterval(reaper);
    server.close();
    void manager.stopAll().finally(() => process.exit(0));
  });
}

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => console.log(`previews: listening on ${String(port)}`));
