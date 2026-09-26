import { defineTool, toToolSpec, type Tool, type ToolContext, type ToolSpec } from '@ai-cms/ai';
import { AuthzError, type Env, type Principal } from '@ai-cms/authz';
import { ConflictError } from '@ai-cms/tree';
import { z } from 'zod';

/**
 * What a CMS tool receives when it runs, whether it is called by the native agent loop or
 * through the MCP server (TECHNICAL §7.1). `Extra` carries the services the real tools need
 * (database, changeset, provider and model for the audit…), added by E9/E10.
 */
export type CmsToolContext<Extra extends object = object> = ToolContext & {
  principal: Principal;
  env: Env;
} & Extra;

/** The per-session part of the context: everything except the per-call fields. */
export type CmsSessionContext<Extra extends object = object> = Omit<
  CmsToolContext<Extra>,
  keyof ToolContext
>;

export interface CmsTool<
  S extends z.ZodObject = z.ZodObject,
  Extra extends object = object,
> extends Omit<Tool<S>, 'run'> {
  run(input: z.output<S>, ctx: CmsToolContext<Extra>): unknown;
}

export function defineCmsTool<S extends z.ZodObject, Extra extends object = object>(
  tool: CmsTool<S, Extra>,
): CmsTool<S, Extra> {
  // Reuses the name validation of @ai-cms/ai; the context type is the only difference.
  defineTool({ ...tool, run: () => undefined });
  return tool;
}

export interface ToolCallResult {
  content: string;
  isError: boolean;
}

export interface ToolRegistry<Extra extends object = object> {
  register<S extends z.ZodObject>(tool: CmsTool<S, Extra>): void;
  get(name: string): CmsTool<z.ZodObject, Extra> | undefined;
  list(): CmsTool<z.ZodObject, Extra>[];
  /** JSON Schema descriptions, as sent to models and MCP clients. */
  specs(): ToolSpec[];
  /**
   * Validates the input and runs the tool. Never throws: unknown tools, invalid input,
   * authorization denials and other failures become an error result the model can read.
   */
  call(name: string, input: unknown, ctx: CmsToolContext<Extra>): Promise<ToolCallResult>;
  /** Tools bound to a session, for the native agent loop (`runAgent`). */
  bind(session: CmsSessionContext<Extra>): Tool[];
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  return JSON.stringify(output);
}

/** Italian message for a failed tool call, safe to show to the model and the user. */
export function toolErrorMessage(err: unknown): string {
  if (err instanceof AuthzError) return `Permesso negato: ${err.message}`;
  if (err instanceof ConflictError) {
    // FR-64: the model should not just retry the same write with the new version, it should
    // read what changed and offer the user a merge of the two sets of changes.
    return (
      `${err.message} Non sovrascrivere semplicemente con la stessa modifica: leggi di nuovo ` +
      "il nodo e proponi all'utente un'unione tra le tue modifiche e quelle già salvate."
    );
  }
  if (err instanceof Error) return `Errore: ${err.message}`;
  return `Errore: ${String(err)}`;
}

export function createToolRegistry<Extra extends object = object>(): ToolRegistry<Extra> {
  const tools = new Map<string, CmsTool<z.ZodObject, Extra>>();

  const registry: ToolRegistry<Extra> = {
    register(tool) {
      if (tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
      defineCmsTool(tool);
      tools.set(tool.name, tool as unknown as CmsTool<z.ZodObject, Extra>);
    },
    get: (name) => tools.get(name),
    list: () => [...tools.values()],
    specs: () => [...tools.values()].map((tool) => toToolSpec(tool as unknown as Tool)),
    async call(name, input, ctx) {
      const tool = tools.get(name);
      if (!tool) return { content: `Strumento sconosciuto: ${name}`, isError: true };
      const parsed = tool.input.safeParse(input ?? {});
      if (!parsed.success) {
        return {
          content: `Input non valido per ${name}:\n${z.prettifyError(parsed.error)}`,
          isError: true,
        };
      }
      try {
        return { content: stringifyOutput(await tool.run(parsed.data, ctx)), isError: false };
      } catch (err) {
        return { content: toolErrorMessage(err), isError: true };
      }
    },
    bind(session) {
      return [...tools.values()].map((tool): Tool => ({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        ...(tool.action !== undefined ? { action: tool.action } : {}),
        // runAgent validates the input and turns thrown errors into error results; the
        // rethrow gives them the same wording as through MCP.
        run: async (input, callCtx) => {
          try {
            return await tool.run(input, { ...session, ...callCtx } as CmsToolContext<Extra>);
          } catch (err) {
            throw new Error(toolErrorMessage(err), { cause: err });
          }
        },
      }));
    },
  };
  return registry;
}

/**
 * Registers a group of tools, e.g. `contentTools`. `register` is generic on the schema of a
 * single tool, so a list of tools with different inputs does not fit it: the one cast this
 * needs lives here, and the registry still validates each input against its own schema.
 */
export function registerTools<Extra extends object = object>(
  registry: ToolRegistry<Extra>,
  tools: readonly CmsTool<z.ZodObject, Extra>[],
): void {
  for (const tool of tools) registry.register(tool);
}
