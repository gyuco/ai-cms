import { resolveAgentSession } from '@ai-cms/ai-config';
import type { Principal } from '@ai-cms/authz';
import {
  contentTools,
  createMcpHandler,
  devTools,
  createToolRegistry,
  exampleTools,
  registerTools,
  type ContentContext,
  type ContentExtra,
  type ContentSession,
  type DevExtra,
  type ToolRegistry,
} from '@ai-cms/mcp-tools';
import { assetStorage } from './assets.ts';
import { db } from './db.ts';
import { createDevServices } from './dev-services.ts';
import type { Env } from './http.ts';
import { checkPageVersion, renderValidator } from './page-rules.ts';
import { revalidateSite } from './sites.ts';

/**
 * The tools the agents call, native engine and CLI alike (TECHNICAL §7.1). The content tools
 * (E9.1) receive the services they cannot build: the connection, the storage, the HTML rules of
 * E6.7 and the hook that asks the site to regenerate what changed.
 */
export const registry: ToolRegistry<ContentExtra & DevExtra> = createToolRegistry<
  ContentExtra & DevExtra
>();
registerTools<ContentExtra & DevExtra>(registry, [...exampleTools, ...contentTools, ...devTools]);

/** The pipeline as the developer tools see it (E10.6); they refuse any other agent. */
const dev = createDevServices();

/**
 * The context a content tool runs with. `db` and the rules are cheap; the storage is passed in
 * because it is a promise the caller already awaited (S3 buckets are created on first use).
 */
export function contentContext(
  principal: Principal,
  env: Env,
  session: ContentSession,
  storage: Awaited<ReturnType<typeof assetStorage>>,
): ContentContext & DevExtra {
  return {
    principal,
    env,
    db: db(),
    storage,
    onPublished: revalidateSite,
    validateRendered: renderValidator(db(), principal, env),
    checkPage: (path, body) => checkPageVersion(db(), principal, env, path, body),
    dev,
    ...session,
  } as ContentContext & DevExtra;
}

/**
 * MCP server for the CLI engines (TECHNICAL §7.3), reachable only on the `control` network.
 * The bearer token is an agent session: it fixes who the agent acts for, its profile and env.
 */
export const mcpHandler = createMcpHandler({
  registry,
  resolvePrincipal: async (token) => (await resolveAgentSession(db(), token))?.principal ?? null,
  createContext: async (principal, { token }) => {
    const session = await resolveAgentSession(db(), token);
    if (!session) throw new Error('Sessione agente scaduta');
    return contentContext(principal, session.env, session, await assetStorage());
  },
});
