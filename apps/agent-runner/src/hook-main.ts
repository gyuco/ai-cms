import { createCmsClient } from './cms-client.ts';
import { runPreToolUseHook } from './hook.ts';

// Entry point of the PreToolUse hook, bundled to dist/pre-tool-use.mjs (see package.json)
// and referenced by the `.claude/settings.json` the runner writes in each clone.

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const output = await runPreToolUseHook(await readStdin(), () => {
  const { CMS_API_URL, CMS_AGENT_TOKEN, CMS_WORKSPACE } = process.env;
  if (!CMS_API_URL || !CMS_AGENT_TOKEN || !CMS_WORKSPACE) {
    throw new Error(
      'configurazione del hook incompleta (CMS_API_URL, CMS_AGENT_TOKEN, CMS_WORKSPACE)',
    );
  }
  const cms = createCmsClient({ baseUrl: CMS_API_URL });
  return {
    workspace: CMS_WORKSPACE,
    authorize: (use) => cms.authorize(CMS_AGENT_TOKEN, use),
  };
});
if (output.stdout) process.stdout.write(output.stdout);
if (output.stderr) process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
