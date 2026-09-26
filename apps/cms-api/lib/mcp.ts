import { createMcpHandler, createToolRegistry, exampleTools } from '@ai-cms/mcp-tools';

// Only the example tools until the content tools arrive (E9.1).
const registry = createToolRegistry();
for (const tool of exampleTools) registry.register(tool);

/** MCP server for the CLI engines (TECHNICAL §7.3), reachable only on the `control` network. */
export const mcpHandler = createMcpHandler({
  registry,
  // TODO(E8.7 integration): resolve the session token with `resolveAgentSession` from
  // @ai-cms/ai-config. Until then every request is rejected with 401.
  resolvePrincipal: async () => null,
  // TODO(E8.7 integration): take the environment from the agent session, not a default.
  createContext: (principal) => ({ principal, env: 'staging' }),
});
