import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { ApiError } from '../api.ts';
import { Bubble } from '../chat/bubbles.tsx';
import { chatReducer, EMPTY_CHAT, type SavedLine } from '../chat/state.ts';
import { streamChat, type PlanView } from '../chat/stream.ts';
import { usePlanPreview, type PreviewState } from '../chat/use-preview.ts';
import { formatDateTime, plural } from '../format.ts';
import { selection, useSelection } from '../selection.ts';
import { useWidget } from '../widget-context.ts';
import { ConfirmButton, errorMessage, Status, useAction, useLoad } from './common.tsx';
import { DevChat } from './dev-chat.tsx';

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

function PreviewNote({ preview }: { preview: PreviewState }) {
  if (preview.status === 'loading') return <p class="chat-preview-note">Preparo l’anteprima…</p>;
  if (preview.status === 'error') {
    return (
      <p class="status status-warning" role="alert">
        Anteprima non disponibile: {preview.message}
      </p>
    );
  }
  if (preview.status !== 'shown') return null;
  return (
    <div class="chat-preview-note">
      <p>
        Anteprima sulla pagina: <span class="chat-preview-added">verde = aggiunto</span>,{' '}
        <span class="chat-preview-modified">giallo = modificato</span>.
      </p>
      {preview.removed.length > 0 && (
        <p>
          {plural(preview.removed.length, 'blocco tolto', 'blocchi tolti')} (non visibili):{' '}
          {preview.removed.map((block) => block.type).join(', ')}.
        </p>
      )}
    </div>
  );
}

function PlanCard({
  plan,
  busy,
  preview,
  previewOn,
  onPreviewToggle,
  onAnswer,
}: {
  plan: PlanView;
  busy: boolean;
  preview: PreviewState;
  previewOn: boolean;
  onPreviewToggle: (on: boolean) => void;
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
      {preview.status !== 'elsewhere' || previewOn ? (
        <label class="chat-preview-toggle">
          <input
            type="checkbox"
            checked={previewOn}
            onChange={(event) => onPreviewToggle((event.target as HTMLInputElement).checked)}
          />{' '}
          Mostra l’anteprima sulla pagina
        </label>
      ) : null}
      <PreviewNote preview={preview} />
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

/** The content agent, about the page you are looking at (E7.4). */
function ContentChat() {
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
  const [previewOn, setPreviewOn] = useState(true);
  const preview = usePlanPreview(api, state.plan, state.conversationId, path, previewOn);

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
        {state.plan && (
          <PlanCard
            plan={state.plan}
            busy={answer.busy || busy}
            preview={preview}
            previewOn={previewOn}
            onPreviewToggle={setPreviewOn}
            onAnswer={respond}
          />
        )}
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

type Mode = 'content' | 'dev';

/**
 * Chat tab (E7.4, E10.11): the content agent about the page you are on, and, in staging, the
 * developer agent working on a change of its own.
 */
export function ChatTab() {
  const { context } = useWidget();
  const [mode, setMode] = useState<Mode>('content');
  if (context.env !== 'staging') return <ContentChat />;
  return (
    <div class="chat-modes">
      <div class="chat-mode" role="group" aria-label="Con chi vuoi parlare">
        <button
          type="button"
          class={mode === 'content' ? 'button small' : 'button secondary small'}
          aria-pressed={mode === 'content'}
          onClick={() => setMode('content')}
        >
          Contenuti
        </button>
        <button
          type="button"
          class={mode === 'dev' ? 'button small' : 'button secondary small'}
          aria-pressed={mode === 'dev'}
          onClick={() => setMode('dev')}
        >
          Sviluppo
        </button>
      </div>
      {mode === 'content' ? <ContentChat /> : <DevChat />}
    </div>
  );
}
