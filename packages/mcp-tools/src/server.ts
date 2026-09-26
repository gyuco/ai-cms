import type { Principal } from '@ai-cms/authz';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import type { CmsSessionContext, ToolRegistry } from './registry.ts';

export interface ToolCallRecord {
  principal: Principal;
  tool: string;
  input: unknown;
  isError: boolean;
  durationMs: number;
}

export interface McpHandlerOptions<Extra extends object = object> {
  registry: ToolRegistry<Extra>;
  /** Resolves the short-lived session token (TECHNICAL §7.3); null rejects the request. */
  resolvePrincipal(token: string): Promise<Principal | null>;
  /** Builds the rest of the tool context (environment, services…) for a resolved principal. */
  createContext(
    principal: Principal,
    info: { token: string; request: Request },
  ): CmsSessionContext<Extra> | Promise<CmsSessionContext<Extra>>;
  /** Called after every tool call, e.g. to write the audit log. Failures are ignored. */
  onToolCall?(record: ToolCallRecord, session: CmsSessionContext<Extra>): void | Promise<void>;
  serverInfo?: { name: string; version: string };
}

const BEARER = /^Bearer\s+(\S+)\s*$/i;

function jsonRpcError(status: number, message: string, headers?: Record<string, string>) {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32000, message }, id: null },
    { status, ...(headers ? { headers } : {}) },
  );
}

/**
 * Stateless MCP server over Streamable HTTP: every request carries its own bearer token and
 * gets a fresh server and transport, so nothing is kept between requests and any cms-api
 * instance can answer. Responses are plain JSON (no SSE streams).
 */
export function createMcpHandler<Extra extends object = object>(
  options: McpHandlerOptions<Extra>,
): (request: Request) => Promise<Response> {
  const { registry } = options;
  const serverInfo = options.serverInfo ?? { name: 'ai-cms', version: '0.0.0' };

  return async (request) => {
    if (request.method !== 'POST') {
      // Stateless: no standalone SSE stream (GET) and no session to delete (DELETE).
      return jsonRpcError(405, 'Metodo non consentito.', { Allow: 'POST' });
    }
    const token = BEARER.exec(request.headers.get('authorization') ?? '')?.[1];
    const principal = token ? await options.resolvePrincipal(token) : null;
    if (!token || !principal) {
      return jsonRpcError(401, 'Token di sessione mancante o non valido.', {
        'WWW-Authenticate': 'Bearer',
      });
    }
    const session = await options.createContext(principal, { token, request });

    const server = new Server(serverInfo, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: registry.specs().map((spec): McpTool => ({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema as McpTool['inputSchema'],
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
      const started = performance.now();
      const input = req.params.arguments ?? {};
      const result = await registry.call(req.params.name, input, {
        ...session,
        toolCallId: String(extra.requestId),
        signal: extra.signal,
      } as Parameters<ToolRegistry<Extra>['call']>[2]);
      if (options.onToolCall) {
        try {
          await options.onToolCall(
            {
              principal,
              tool: req.params.name,
              input,
              isError: result.isError,
              durationMs: Math.round(performance.now() - started),
            },
            session,
          );
        } catch {
          // Auditing must not turn a completed tool call into a failure for the agent.
        }
      }
      return {
        content: [{ type: 'text', text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  };
}
