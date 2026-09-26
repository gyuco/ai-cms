import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentDatabaseUrl } from '@ai-cms/pipeline/builder';
import { deleteArtifacts } from './artifact.ts';
import { executeRun, type BuilderConfig } from './run.ts';
import { RunManager } from './runs.ts';
import { createBuilderHandler } from './server.ts';

/** BUILDER_TOKEN in local development, otherwise the `builder_token` Docker secret. */
function readToken(): string {
  if (process.env.BUILDER_TOKEN) return process.env.BUILDER_TOKEN;
  const dir = process.env.SECRETS_DIR ?? '/run/secrets';
  return readFileSync(join(dir, 'builder_token'), 'utf8').trim();
}

const config: BuilderConfig = {
  platformRoot: process.env.PLATFORM_ROOT || fileURLToPath(new URL('../../..', import.meta.url)),
  workRoot: process.env.BUILDER_WORK_ROOT || join(tmpdir(), 'ai-cms-builder'),
  workspacesRoot: process.env.WORKSPACES_ROOT || '/data/workspaces',
  artifactsRoot: process.env.ARTIFACTS_ROOT || '/data/artifacts',
  contentDatabaseUrl: contentDatabaseUrl(),
};
const port = Number(process.env.PORT ?? 8090);

const runs = new RunManager({
  concurrency: Number(process.env.BUILDER_CONCURRENCY ?? 1),
  execute: (request, report) => executeRun(request, config, report),
});

const server = createServer(
  createBuilderHandler({
    runs,
    token: readToken(),
    deleteArtifacts: (id) => deleteArtifacts(config.artifactsRoot, id),
  }),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`builder: ${signal}, stopping`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

server.listen(port, () => {
  console.log(`builder: listening on ${String(port)}, platform=${config.platformRoot}`);
});
