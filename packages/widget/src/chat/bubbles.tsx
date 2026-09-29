import type { ChatMessage } from './state.ts';

const STATUS_ICON = { running: '…', done: '✓', failed: '✗', blocked: '⛔' } as const;
const STATUS_TEXT = {
  running: 'in corso',
  done: 'fatto',
  failed: 'non riuscito',
  blocked: 'non consentito',
} as const;

export function ToolList({ message }: { message: ChatMessage }) {
  if (message.tools.length === 0) return null;
  return (
    <ul class="chat-tools">
      {message.tools.map((step) => (
        <li key={step.id} class={`chat-tool chat-tool-${step.status}`}>
          <span aria-hidden="true">{STATUS_ICON[step.status]}</span> {step.label}
          <span class="visually-hidden"> ({STATUS_TEXT[step.status]})</span>
          {step.detail && <span class="chat-tool-detail">{step.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

export function Bubble({ message }: { message: ChatMessage }) {
  if (message.role === 'note') return <p class="chat-note">{message.text}</p>;
  const who = message.role === 'user' ? 'Tu' : 'Agente';
  return (
    <div class={`chat-message chat-${message.role}`}>
      <p class="chat-who">{who}</p>
      {message.text && <p class="chat-text">{message.text}</p>}
      <ToolList message={message} />
    </div>
  );
}
