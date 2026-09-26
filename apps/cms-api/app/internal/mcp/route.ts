import { mcpHandler } from '@/lib/mcp.ts';

// Served at /_cms/internal/mcp; Caddy blocks /_cms/internal/* on public hosts.
// GET and DELETE get a 405 from the handler: the server is stateless.
export const POST = mcpHandler;
export const GET = mcpHandler;
export const DELETE = mcpHandler;
