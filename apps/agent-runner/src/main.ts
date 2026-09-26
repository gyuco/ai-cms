import path from 'node:path';
import { shellQuote } from './claude-settings.ts';
import { createCmsClient } from './cms-client.ts';
import { createRunner } from './runner.ts';
import { createRunnerServer } from './server.ts';

// agent-runner service (TECHNICAL §3.1): no database, no API keys, only the control network.
const port = Number(process.env.PORT ?? 8070);
const hookScript =
  process.env.HOOK_SCRIPT ?? path.resolve(import.meta.dirname, '../dist/pre-tool-use.mjs');

const runner = createRunner({
  cms: createCmsClient({ baseUrl: process.env.CMS_API_URL ?? 'http://cms-api:3100' }),
  workspacesRoot: process.env.WORKSPACES_ROOT ?? '/data/workspaces',
  cliAuthRoot: process.env.CLI_AUTH_ROOT ?? '/cli-auth',
  hookCommand: `${shellQuote(process.execPath)} ${shellQuote(hookScript)}`,
});
const server = createRunnerServer(runner);

server.listen(port, '0.0.0.0', () => {
  console.log(`agent-runner: listening on ${port}`);
});

function shutdown() {
  for (const run of server.runs.values()) run.controller.abort();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
