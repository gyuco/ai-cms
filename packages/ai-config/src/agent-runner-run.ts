import type { Database } from '@ai-cms/db';
import {
  issueAgentSession,
  revokeAgentSession,
  type IssueAgentSessionInput,
} from './agent-sessions.ts';

/** One line of the NDJSON stream of `POST /runs` on the agent-runner (`RunnerEvent`). */
export interface RunnerStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface AgentRunOptions {
  /** `AGENT_RUNNER_URL`, e.g. `http://agent-runner:8070`. */
  runnerUrl?: string;
  fetch?: typeof fetch;
  /** Longest a single run may take. */
  timeoutMs?: number;
  /** Stops the run when the caller goes away. */
  signal?: AbortSignal;
}

export interface AgentRunInput {
  /** The session the run acts under; its token lives only as long as the run. */
  session: Omit<IssueAgentSessionInput, 'ttlMs'>;
  engine: 'claude-code' | 'native';
  prompt: string;
  resumeSessionId?: string;
  /** Native engine: the conversation so far, without the new prompt. */
  messages?: unknown[];
}

export const DEFAULT_RUN_TIMEOUT_MS = 20 * 60_000;

function runnerBase(options: AgentRunOptions): string {
  return (options.runnerUrl ?? process.env.AGENT_RUNNER_URL ?? 'http://agent-runner:8070').replace(
    /\/+$/,
    '',
  );
}

/**
 * One run of an agent on the agent-runner: issues a short-lived session, asks the runner to
 * run `prompt` and yields the events of the stream as they arrive. A run that cannot start, or
 * that breaks half way, ends with an `error` event instead of throwing, so callers only read.
 * The session is revoked when the stream ends or the consumer stops reading.
 */
export async function* streamAgentRun(
  db: Database,
  input: AgentRunInput,
  options: AgentRunOptions = {},
): AsyncGenerator<RunnerStreamEvent> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const { token } = await issueAgentSession(db, { ...input.session, ttlMs: timeoutMs + 60_000 });
  try {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`${runnerBase(options)}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          engine: input.engine,
          prompt: input.prompt,
          ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
          ...(input.messages ? { messages: input.messages } : {}),
        }),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      yield { type: 'error', message: (error as Error).message };
      return;
    }
    if (!response.ok || !response.body) {
      yield {
        type: 'error',
        message: response.ok
          ? 'risposta vuota'
          : `l'agent-runner ha risposto ${String(response.status)}`,
      };
      return;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    const parse = (line: string): RunnerStreamEvent | null => {
      if (!line.trim()) return null;
      try {
        const event = JSON.parse(line) as unknown;
        return event &&
          typeof event === 'object' &&
          typeof (event as { type?: unknown }).type === 'string'
          ? (event as RunnerStreamEvent)
          : null;
      } catch {
        return null;
      }
    };
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const event = parse(line);
          if (event) yield event;
        }
      }
      const last = parse(buffer);
      if (last) yield last;
    } catch (error) {
      yield { type: 'error', message: (error as Error).message };
    }
  } finally {
    await revokeAgentSession(db, token).catch(() => undefined);
  }
}
