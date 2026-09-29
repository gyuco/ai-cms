import type { ChatEvent, PlanView } from './stream.ts';

export type ToolStatus = 'running' | 'done' | 'failed' | 'blocked';

export interface ToolStep {
  id: string;
  name: string;
  label: string;
  status: ToolStatus;
  /** Why it failed or was refused, in Italian. */
  detail?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'note';
  text: string;
  tools: ToolStep[];
  /** The assistant is still writing this message. */
  streaming?: boolean;
}

export type Phase = 'idle' | 'thinking' | 'working';

export interface ChatState {
  conversationId: string | null;
  title: string | null;
  messages: ChatMessage[];
  plan: PlanView | null;
  phase: Phase;
  error: string | null;
  /** The agent changed the site during this conversation: the page on screen may be stale. */
  changed: boolean;
  /** The developer agent asked for packages the person has not approved yet. */
  dependencyNeeded: boolean;
}

export const EMPTY_CHAT: ChatState = {
  conversationId: null,
  title: null,
  messages: [],
  plan: null,
  phase: 'idle',
  error: null,
  changed: false,
  dependencyNeeded: false,
};

/** A saved line of a conversation, as `GET /_cms/api/chat/conversations/:id` returns it. */
export interface SavedLine {
  id: number;
  role: 'user' | 'assistant' | 'note';
  text: string;
  tools: string[];
}

export type ChatAction =
  | { kind: 'reset' }
  | {
      kind: 'loaded';
      id: string;
      title: string | null;
      lines: SavedLine[];
      plan: PlanView | null;
    }
  | { kind: 'send'; text: string }
  | { kind: 'event'; event: ChatEvent }
  | { kind: 'stopped' }
  | { kind: 'failed'; message: string }
  | { kind: 'plan-answered'; note: string; applied: boolean }
  | { kind: 'note'; text: string; dependencyApproved?: boolean };

/** Tools that only read: the site is the same after them. */
const READ_ONLY = new Set([
  'list_nodes',
  'read_node',
  'propose_plan',
  'list_files',
  'read_file',
  'search',
  'get_check_results',
  'query_staging_db',
  'open_preview',
]);

const BLOCKED_PREFIX = 'Permesso negato:';

/** What the user reads for a refused or failed tool call. */
export function explainFailure(detail: string | undefined, blocked: boolean): string {
  const text = (detail ?? '').trim();
  if (blocked) {
    const reason = text.startsWith(BLOCKED_PREFIX)
      ? text.slice(BLOCKED_PREFIX.length).trim()
      : text;
    return reason ? `Non consentito: ${reason}` : 'Non consentito dalle regole del sito.';
  }
  return text.replace(/^Errore:\s*/, '') || 'Non è riuscito.';
}

let counter = 0;
const nextId = () => `m${++counter}`;

/** The assistant message of the running turn, opened on first use. */
function withAssistant(state: ChatState): { messages: ChatMessage[]; current: ChatMessage } {
  const last = state.messages.at(-1);
  if (last?.role === 'assistant' && last.streaming) {
    const current = { ...last, tools: [...last.tools] };
    return { messages: [...state.messages.slice(0, -1), current], current };
  }
  const current: ChatMessage = {
    id: nextId(),
    role: 'assistant',
    text: '',
    tools: [],
    streaming: true,
  };
  return { messages: [...state.messages, current], current };
}

function stopStreaming(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => (m.streaming ? { ...m, streaming: false } : m));
}

function reduceEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case 'conversation':
      return { ...state, conversationId: event.id, title: event.title };
    case 'status':
      return { ...state, phase: event.state };
    case 'text': {
      const { messages, current } = withAssistant(state);
      current.text += event.text;
      return { ...state, messages };
    }
    case 'tool_start': {
      const { messages, current } = withAssistant(state);
      current.tools.push({
        id: event.id,
        name: event.name,
        label: event.label,
        status: 'running',
      });
      return { ...state, messages, phase: 'working' };
    }
    case 'tool_end': {
      const { messages, current } = withAssistant(state);
      current.tools = current.tools.map((step) =>
        step.id === event.id
          ? {
              ...step,
              status: event.ok ? 'done' : event.blocked ? 'blocked' : 'failed',
              ...(event.ok ? {} : { detail: explainFailure(event.detail, event.blocked) }),
            }
          : step,
      );
      return {
        ...state,
        messages,
        changed: state.changed || (event.ok && !READ_ONLY.has(event.name)),
      };
    }
    case 'plan':
      return { ...state, plan: event.plan };
    case 'commit':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: nextId(),
            role: 'note',
            text: `Modifiche salvate (${event.files.length === 1 ? '1 file' : `${event.files.length} file`}): ${event.files.slice(0, 5).join(', ')}${event.files.length > 5 ? '…' : ''}`,
            tools: [],
          },
        ],
      };
    case 'dependency':
      return { ...state, dependencyNeeded: true };
    case 'error':
      return { ...state, error: event.message };
    case 'done':
      return { ...state, phase: 'idle', messages: stopStreaming(state.messages) };
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case 'reset':
      return EMPTY_CHAT;
    case 'loaded':
      return {
        ...EMPTY_CHAT,
        conversationId: action.id,
        title: action.title,
        plan: action.plan,
        messages: action.lines.map((line) => ({
          id: `s${line.id}`,
          role: line.role,
          text: line.text,
          tools: line.tools.map((label, i) => ({
            id: `s${line.id}-${i}`,
            name: '',
            label,
            status: 'done' as const,
          })),
        })),
      };
    case 'send':
      return {
        ...state,
        error: null,
        phase: 'thinking',
        // A new question replaces the plan that was waiting: the agent proposes it again.
        plan: null,
        messages: [...state.messages, { id: nextId(), role: 'user', text: action.text, tools: [] }],
      };
    case 'event':
      return reduceEvent(state, action.event);
    case 'stopped':
      return { ...state, phase: 'idle', messages: stopStreaming(state.messages) };
    case 'failed':
      return {
        ...state,
        phase: 'idle',
        error: action.message,
        messages: stopStreaming(state.messages),
      };
    case 'plan-answered':
      return {
        ...state,
        plan: null,
        changed: state.changed || action.applied,
        messages: [...state.messages, { id: nextId(), role: 'note', text: action.note, tools: [] }],
      };
    case 'note':
      return {
        ...state,
        dependencyNeeded: action.dependencyApproved ? false : state.dependencyNeeded,
        messages: [...state.messages, { id: nextId(), role: 'note', text: action.text, tools: [] }],
      };
  }
}
