import { z } from 'zod';
import type { ToolSpec } from './types.ts';

export interface ToolContext {
  toolCallId: string;
  signal?: AbortSignal;
}

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  /** Permission the tool needs (checked by the tool itself through authz, FR-132). */
  action?: string;
  /** Returns the result for the model: strings are sent as-is, anything else as JSON. */
  run(input: z.output<S>, ctx: ToolContext): unknown;
}

// Accepted by both Anthropic and OpenAI-style APIs.
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function defineTool<S extends z.ZodObject>(tool: Tool<S>): Tool<S> {
  if (!TOOL_NAME.test(tool.name)) {
    throw new Error(`Invalid tool name "${tool.name}": use 1-64 letters, digits, _ or -`);
  }
  return tool;
}

export function toToolSpec(tool: Tool): ToolSpec {
  const inputSchema: Record<string, unknown> = z.toJSONSchema(tool.input, { io: 'input' });
  delete inputSchema.$schema;
  return { name: tool.name, description: tool.description, inputSchema };
}

export function toToolSpecs(tools: readonly Tool[]): ToolSpec[] {
  return tools.map(toToolSpec);
}
