import { resolveAgentSession } from '@ai-cms/ai-config';
import { createMcpHandler, createToolRegistry, exampleTools } from '@ai-cms/mcp-tools';
import { db } from './db.ts';

// Only the example tools until the content tools arrive (E9.1).
export const registry = createToolRegistry<{
  conversationId: string | null;
  changesetId: string | null;
}>();
for (const tool of exampleTools) registry.register(tool);

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
    return {
      principal,
      env: session.env,
      conversationId: session.conversationId,
      changesetId: session.changesetId,
    };
  },
});
