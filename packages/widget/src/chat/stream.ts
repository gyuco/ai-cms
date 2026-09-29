import { API_BASE, failure } from '../api.ts';

/** One page a plan touches (`PlanPageView` in `@ai-cms/agents`). */
export interface PlanPage {
  path: string;
  created: boolean;
  added: number;
  removed: number;
  changed: number;
}

/** A plan waiting for the answer (`PlanView` in `@ai-cms/agents`). */
export interface PlanView {
  steps: string[];
  pages: PlanPage[];
  /** The plan deletes or overwrites: it needs an explicit confirmation (FR-06). */
  destructive: boolean;
}

/**
 * The events of the chat stream (`ChatStreamEvent` in `@ai-cms/agents`). The widget cannot
 * import server packages, so the shape is repeated here.
 */
export type ChatEvent =
  | { type: 'conversation'; id: string; title: string | null }
  | { type: 'status'; state: 'thinking' | 'working' }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string; label: string }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      ok: boolean;
      blocked: boolean;
      detail?: string;
    }
  | { type: 'plan'; plan: PlanView }
  | { type: 'commit'; commit: string; files: string[] }
  | { type: 'dependency'; detail: string }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason: string };

/** Splits a server-sent event stream into events, whatever the size of the chunks. */
export function createSseParser(onEvent: (event: ChatEvent) => void) {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk.replace(/\r\n/g, '\n');
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end < 0) return;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          onEvent(JSON.parse(data) as ChatEvent);
        } catch {
          // A frame that is not JSON is not ours: ignore it.
        }
      }
    },
  };
}

export interface ChatRequest {
  /** `dev-agent` talks to the developer agent about `changesetId` (staging only). */
  agent?: 'dev-agent';
  changesetId?: string;
  message: string;
  conversationId: string | null;
  /** Tree path of the page the widget is on. */
  path: string | null;
  selected: { path: string | null; blockId: string; text: string } | null;
}

/**
 * Sends one message and calls `onEvent` for everything the agent does, until the stream ends
 * or `signal` aborts. Rejects with an `ApiError` when the request is refused.
 */
export async function streamChat(
  csrfToken: string,
  request: ChatRequest,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchFn(`${API_BASE}/chat`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await failure(response);
  if (!response.body) return;
  const parser = createSseParser(onEvent);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
}
