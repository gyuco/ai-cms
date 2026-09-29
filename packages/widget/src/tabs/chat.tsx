import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { ApiError } from '../api.ts';
import { chatReducer, EMPTY_CHAT, type ChatMessage, type SavedLine } from '../chat/state.ts';
import { streamChat, type PlanView } from '../chat/stream.ts';
import { formatDateTime, plural } from '../format.ts';
import { selection, useSelection } from '../selection.ts';
import { useWidget } from '../widget-context.ts';
import { ConfirmButton, errorMessage, Status, useAction, useLoad } from './common.tsx';

interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

interface SavedConversation {
  id: string;
  title: string | null;
  lines: SavedLine[];
  plan: PlanView | null;
}

interface PlanAnswer {
  status: 'applied' | 'cancelled';
  touched?: string[];
  hookError?: string;
}

const STATUS_ICON = { running: '…', done: '✓', failed: '✗', blocked: '⛔' } as const;
const STATUS_TEXT = {
  running: 'in corso',
  done: 'fatto',
  failed: 'non riuscito',
  blocked: 'non consentito',
} as const;

function ToolList({ message }: { message: ChatMessage }) {
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

function Bubble({ message }: { message: ChatMessage }) {
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

function PlanCard({
  plan,
  busy,
  onAnswer,
}: {
  plan: PlanView;
  busy: boolean;
  onAnswer: (action: 'confirm' | 'cancel', confirmDestructive: boolean) => void;
}) {
  return (
    <section class="chat-plan" aria-label="Piano proposto">
      <h4 class="chat-plan-title">Piano proposto</h4>
      <ol class="chat-plan-steps">
        {plan.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {plan.pages.length > 0 && (
        <ul class="plain-list chat-plan-pages">
          {plan.pages.map((page) => (
            <li key={page.path}>
              <code>{page.path}</code>:{' '}
              {page.created
                ? 'nuova pagina'
                : `${plural(page.added, 'blocco aggiunto', 'blocchi aggiunti')}, ` +
                  `${plural(page.removed, 'rimosso', 'rimossi')}, ` +
                  `${plural(page.changed, 'modificato', 'modificati')}`}
            </li>
          ))}
        </ul>
      )}
      {plan.destructive && (
        <p class="status status-warning" role="alert">
          Questo piano elimina o sovrascrive dei contenuti: controlla bene prima di confermare.
        </p>
      )}
      <div class="actions">
        {plan.destructive ? (
          <ConfirmButton
            label="Conferma"
            question="Eseguire il piano? I contenuti eliminati o sovrascritti si possono recuperare solo dalle versioni."
            confirmLabel="Sì, esegui"
            disabled={busy}
            onConfirm={() => onAnswer('confirm', true)}
          />
        ) : (
          <button
            type="button"
            class="button"
            disabled={busy}
            onClick={() => onAnswer('confirm', false)}
          >
            Conferma
          </button>
        )}
        <button
          type="button"
          class="button secondary"
          disabled={busy}
          onClick={() => onAnswer('cancel', false)}
        >
          Annulla
        </button>
      </div>
    </section>
  );
}

/** Chat tab (E7.4): talk to the content agent about the page you are looking at. */
export function ChatTab() {
  const { context, api, reload } = useWidget();
  const { selected } = useSelection();
  const [state, dispatch] = useReducer(chatReducer, EMPTY_CHAT);
  const [draft, setDraft] = useState('');
  const abort = useRef<AbortController | null>(null);
  const latest = useRef(state);
  latest.current = state;
  const log = useRef<HTMLDivElement>(null);
  const answer = useAction();

  const path = context.node?.path ?? null;
  const busy = state.phase !== 'idle';

  const history = useLoad(
    () =>
      path
        ? api.get<{ conversations: ConversationSummary[] }>('/chat/conversations', { path })
        : Promise.resolve({ conversations: [] as ConversationSummary[] }),
    [api, path],
  );

  // The conversation belongs to the page: moving to another page starts a new one.
  useEffect(() => {
    abort.current?.abort();
    dispatch({ kind: 'reset' });
  }, [path]);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.plan]);

  useEffect(() => () => abort.current?.abort(), []);

  const open = async (id: string) => {
    if (!id) return dispatch({ kind: 'reset' });
    try {
      const saved = await api.get<SavedConversation>(`/chat/conversations/${id}`);
      dispatch({
        kind: 'loaded',
        id: saved.id,
        title: saved.title,
        lines: saved.lines,
        plan: saved.plan,
      });
    } catch (err) {
      dispatch({ kind: 'failed', message: errorMessage(err) });
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    dispatch({ kind: 'send', text });
    const controller = new AbortController();
    abort.current = controller;
    try {
      await streamChat(
        context.csrfToken,
        {
          message: text,
          conversationId: latest.current.conversationId,
          path,
          selected: selected && {
            path: selected.path,
            blockId: selected.blockId,
            text: selected.text,
          },
        },
        (event) => dispatch({ kind: 'event', event }),
        controller.signal,
      );
      dispatch({ kind: 'stopped' });
    } catch (err) {
      if (controller.signal.aborted) dispatch({ kind: 'stopped' });
      else if (err instanceof ApiError && err.status === 401) {
        dispatch({ kind: 'failed', message: 'La sessione è scaduta: accedi di nuovo.' });
      } else dispatch({ kind: 'failed', message: errorMessage(err) });
    } finally {
      if (abort.current === controller) abort.current = null;
      void history.reload();
    }
  };

  const respond = (action: 'confirm' | 'cancel', confirmDestructive: boolean) => {
    const conversationId = latest.current.conversationId;
    if (!conversationId) return;
    void answer.run(async () => {
      const result = await api.send<PlanAnswer>('POST', '/chat/plan', {
        conversationId,
        action,
        confirmDestructive,
      });
      if (result.status === 'applied') {
        dispatch({ kind: 'plan-answered', applied: true, note: 'Piano eseguito.' });
        void reload();
        return result.hookError
          ? {
              kind: 'warning' as const,
              text: `Piano eseguito, ma il sito non si è aggiornato subito: ${result.hookError}`,
            }
          : 'Piano eseguito.';
      }
      dispatch({ kind: 'plan-answered', applied: false, note: 'Piano annullato.' });
      return 'Piano annullato.';
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const phaseText =
    state.phase === 'thinking'
      ? "L'agente sta pensando…"
      : state.phase === 'working'
        ? "L'agente sta lavorando…"
        : '';

  return (
    <div class="chat">
      <div class="chat-head">
        <label class="visually-hidden" for="cms-chat-history">
          Conversazioni di questa pagina
        </label>
        <select
          id="cms-chat-history"
          class="chat-history"
          value={state.conversationId ?? ''}
          disabled={busy}
          onChange={(event) => void open((event.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">Nuova conversazione</option>
          {(history.data?.conversations ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {(c.title ?? 'Senza titolo').slice(0, 40)} · {formatDateTime(c.updatedAt)}
            </option>
          ))}
        </select>
        {state.messages.length > 0 && (
          <button
            type="button"
            class="button secondary small"
            disabled={busy}
            onClick={() => dispatch({ kind: 'reset' })}
          >
            Nuova
          </button>
        )}
      </div>

      <div
        class="chat-log"
        ref={log}
        role="log"
        aria-live="polite"
        aria-label="Conversazione con l'agente"
        tabIndex={0}
      >
        {state.messages.length === 0 && (
          <p class="muted">
            Chiedi all'agente di creare o modificare pagine, testi, immagini e menu. Puoi anche
            selezionare un elemento della pagina e parlarne.
          </p>
        )}
        {state.messages.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
        {state.plan && <PlanCard plan={state.plan} busy={answer.busy || busy} onAnswer={respond} />}
      </div>

      <p class="chat-phase" role="status" aria-live="polite">
        {phaseText}
      </p>
      {state.error && (
        <p class="status status-error" role="alert">
          {state.error}
        </p>
      )}
      <Status outcome={answer.outcome} />
      {state.changed && !busy && (
        <p class="notice">
          Il sito è stato modificato.{' '}
          <button type="button" class="link-button" onClick={() => window.location.reload()}>
            Ricarica la pagina
          </button>
        </p>
      )}

      {selected ? (
        <p class="chat-selected">
          <span>
            Elemento selezionato: <strong>{selected.text || selected.blockId}</strong>
          </span>{' '}
          <button type="button" class="link-button" onClick={() => selection.clear()}>
            Togli
          </button>
        </p>
      ) : (
        <p class="chat-selected">
          <button type="button" class="link-button" onClick={() => selection.start()}>
            Seleziona un elemento della pagina
          </button>
        </p>
      )}

      <form
        class="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label class="visually-hidden" for="cms-chat-input">
          Messaggio per l'agente
        </label>
        <textarea
          id="cms-chat-input"
          class="chat-input"
          rows={3}
          value={draft}
          placeholder="Scrivi all'agente… (Invio per inviare, Maiusc+Invio per andare a capo)"
          onInput={(event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
        />
        <div class="actions">
          {busy ? (
            <button type="button" class="button secondary" onClick={() => abort.current?.abort()}>
              Ferma
            </button>
          ) : (
            <button type="submit" class="button" disabled={draft.trim() === ''}>
              Invia
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
