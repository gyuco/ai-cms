import { z } from 'zod';
import { toToolSpecs, type Tool } from './tools.ts';
import type {
  AssistantPart,
  ChatEngine,
  ChatEvent,
  ChatMessage,
  ToolCallPart,
  ToolResultPart,
  Usage,
} from './types.ts';

export type AgentEvent =
  | ChatEvent
  | { type: 'step'; step: number }
  | {
      type: 'tool_result';
      toolCallId: string;
      name: string;
      content: string;
      isError: boolean;
    };

export type AgentStopReason =
  'end_turn' | 'max_steps' | 'max_tokens' | 'refusal' | 'error' | 'aborted';

export interface RunAgentOptions {
  engine: ChatEngine;
  model: string;
  system: string;
  /** Conversation so far; it must end with a user message. */
  messages: ChatMessage[];
  tools: readonly Tool[];
  /** Maximum number of model calls. */
  maxSteps?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Receives every model event plus step and tool result events, e.g. to forward to the chat. */
  onEvent?: (event: AgentEvent) => void;
  /** Asked before running each tool call; returning false skips it with an error result. */
  confirm?: (call: ToolCallPart, tool: Tool) => boolean | Promise<boolean>;
}

export interface AgentResult {
  /** Messages produced by this run, to append to the conversation. */
  messages: ChatMessage[];
  usage: Required<Usage>;
  steps: number;
  stopReason: AgentStopReason;
  /** Error message or refusal explanation. */
  detail?: string;
}

export const DEFAULT_MAX_STEPS = 25;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  return JSON.stringify(output);
}

async function executeToolCall(
  call: ToolCallPart,
  tools: ReadonlyMap<string, Tool>,
  options: Pick<RunAgentOptions, 'confirm' | 'signal'>,
): Promise<ToolResultPart> {
  const fail = (content: string): ToolResultPart => ({
    type: 'tool_result',
    toolCallId: call.id,
    content,
    isError: true,
  });
  const tool = tools.get(call.name);
  if (!tool) return fail(`Strumento sconosciuto: ${call.name}`);
  if (typeof call.input === 'string') {
    return fail(`Input non valido per ${call.name}: JSON non analizzabile: ${call.input}`);
  }
  const parsed = tool.input.safeParse(call.input);
  if (!parsed.success) {
    return fail(`Input non valido per ${call.name}:\n${z.prettifyError(parsed.error)}`);
  }
  try {
    if (options.confirm && !(await options.confirm(call, tool))) {
      return fail("Operazione non confermata dall'utente.");
    }
    const output = await tool.run(parsed.data, {
      toolCallId: call.id,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { type: 'tool_result', toolCallId: call.id, content: stringifyOutput(output) };
  } catch (err) {
    // Tool failures (authorization included) go back to the model, which can adapt.
    return fail(errorMessage(err));
  }
}

/**
 * The native agent loop (TECHNICAL §7.1): calls the engine, runs the requested tools in
 * parallel, sends all results back in one user message and repeats until the model ends
 * its turn, `maxSteps` is reached or the signal aborts.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { engine, model, system, signal, onEvent } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
  const toolSpecs = toToolSpecs(options.tools);
  const produced: ChatMessage[] = [];
  const usage: Required<Usage> = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const emit = (event: AgentEvent) => onEvent?.(event);
  const result = (stopReason: AgentStopReason, steps: number, detail?: string): AgentResult => ({
    messages: produced,
    usage,
    steps,
    stopReason,
    ...(detail !== undefined ? { detail } : {}),
  });

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) return result('aborted', step - 1);
    emit({ type: 'step', step });

    const parts: AssistantPart[] = [];
    let stopReason: ChatEvent & { type: 'done' } = { type: 'done', stopReason: 'error' };
    let error: string | undefined;

    for await (const event of engine.stream({
      model,
      system,
      messages: [...options.messages, ...produced],
      tools: toolSpecs,
      ...(options.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
      ...(signal ? { signal } : {}),
    })) {
      emit(event);
      switch (event.type) {
        case 'text_delta': {
          const last = parts.at(-1);
          if (last?.type === 'text') last.text += event.text;
          else parts.push({ type: 'text', text: event.text });
          break;
        }
        case 'tool_call':
          parts.push({ type: 'tool_call', id: event.id, name: event.name, input: event.input });
          break;
        case 'reasoning':
          parts.push({ type: 'reasoning', provider: event.provider, data: event.data });
          break;
        case 'usage':
          usage.inputTokens += event.inputTokens;
          usage.outputTokens += event.outputTokens;
          usage.cacheReadTokens += event.cacheReadTokens ?? 0;
          usage.cacheWriteTokens += event.cacheWriteTokens ?? 0;
          break;
        case 'error':
          error = event.message;
          break;
        case 'done':
          stopReason = event;
          break;
      }
    }

    const calls = parts.filter((part): part is ToolCallPart => part.type === 'tool_call');
    const reason = stopReason.stopReason;

    if (reason === 'error' || reason === 'refusal') {
      // Unfinished tool calls cannot be answered: keep only the text.
      const text = parts.filter((part) => part.type === 'text');
      if (text.length > 0) produced.push({ role: 'assistant', content: text });
      if (reason === 'refusal') return result('refusal', step, stopReason.detail);
      return signal?.aborted ? result('aborted', step) : result('error', step, error);
    }

    if (parts.length > 0) produced.push({ role: 'assistant', content: parts });
    if (calls.length === 0)
      return result(reason === 'max_tokens' ? 'max_tokens' : 'end_turn', step);

    if (reason === 'max_tokens') {
      // The last tool input may be cut off: do not run anything, but keep the history valid.
      const results = calls.map((call): ToolResultPart => ({
        type: 'tool_result',
        toolCallId: call.id,
        content: 'Non eseguito: risposta troncata dal limite di token in uscita.',
        isError: true,
      }));
      produced.push({ role: 'user', content: results });
      return result('max_tokens', step);
    }

    const results = await Promise.all(
      calls.map((call) => executeToolCall(call, toolMap, { ...options })),
    );
    for (const [i, res] of results.entries()) {
      emit({
        type: 'tool_result',
        toolCallId: res.toolCallId,
        name: calls[i]!.name,
        content: res.content,
        isError: res.isError ?? false,
      });
    }
    produced.push({ role: 'user', content: results });
    if (step === maxSteps) return result('max_steps', step);
  }
  return result('max_steps', maxSteps);
}
