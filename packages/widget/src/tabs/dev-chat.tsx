import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { ApiError } from '../api.ts';
import { Bubble } from '../chat/bubbles.tsx';
import {
  parsePackageNames,
  STATUS_LABEL,
  workableChangesets,
  type ChangesetItem,
} from '../chat/dev.ts';
import { chatReducer, EMPTY_CHAT, type SavedLine } from '../chat/state.ts';
import { streamChat } from '../chat/stream.ts';
import { useWidget } from '../widget-context.ts';
import { errorMessage, Status, useAction, useLoad } from './common.tsx';

interface SavedConversation {
  id: string;
  title: string | null;
  lines: SavedLine[];
}

/** How long the widget waits for the worker to clone the repository of a new change. */
const OPEN_TIMEOUT_MS = 90_000;
const OPEN_POLL_MS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The developer agent (E10.11): pick or open a change, and talk to the agent that writes the
 * code of the site in its own copy. Checks, approval and release are in the Development tab.
 */
export function DevChat() {
  const { context, api } = useWidget();
  const [state, dispatch] = useReducer(chatReducer, EMPTY_CHAT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [title, setTitle] = useState('');
  const [packages, setPackages] = useState('');
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const create = useAction();
  const approve = useAction();

  const list = useLoad(
    async () => (await api.get<{ changesets: ChangesetItem[] }>('/changesets')).changesets,
    [api],
  );
  const changesets = workableChangesets(list.data ?? []);
  const selected = changesets.find((c) => c.id === selectedId) ?? null;
  const busy = state.phase !== 'idle';

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages]);
  useEffect(() => () => abort.current?.abort(), []);

  const choose = async (id: string, items: readonly ChangesetItem[] = changesets) => {
    abort.current?.abort();
    setSelectedId(id || null);
    const item = items.find((c) => c.id === id);
    if (!item?.conversationId) return dispatch({ kind: 'reset' });
    try {
      const saved = await api.get<SavedConversation>(`/chat/conversations/${item.conversationId}`);
      dispatch({
        kind: 'loaded',
        id: saved.id,
        title: saved.title,
        lines: saved.lines,
        plan: null,
      });
    } catch (err) {
      dispatch({ kind: 'failed', message: errorMessage(err) });
    }
  };

  const open = () => {
    const name = title.trim();
    if (!name) return;
    void create.run(async () => {
      const started = await api.send<{ conversationId: string }>('POST', '/changesets', {
        title: name,
      });
      const deadline = Date.now() + OPEN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const { changesets: all } = await api.get<{ changesets: ChangesetItem[] }>('/changesets');
        const found = all.find((c) => c.conversationId === started.conversationId);
        if (found) {
          await list.reload();
          setTitle('');
          await choose(found.id, all);
          return `Modifica «${found.title}» pronta.`;
        }
        await sleep(OPEN_POLL_MS);
      }
      throw new Error('La modifica non è ancora pronta: riprova tra poco dall’elenco.');
    });
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || !selected) return;
    setDraft('');
    dispatch({ kind: 'send', text });
    const controller = new AbortController();
    abort.current = controller;
    try {
      await streamChat(
        context.csrfToken,
        {
          agent: 'dev-agent',
          changesetId: selected.id,
          message: text,
          conversationId: selected.conversationId,
          path: null,
          selected: null,
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
      void list.reload();
    }
  };

  const approvePackages = () => {
    const names = parsePackageNames(packages);
    if (names.length === 0 || !selected?.conversationId) return;
    const conversationId = selected.conversationId;
    void approve.run(async () => {
      await api.send('POST', '/chat/dependencies', { conversationId, packages: names });
      setPackages('');
      dispatch({
        kind: 'note',
        text: `Hai approvato l'aggiunta di: ${names.join(', ')}`,
        dependencyApproved: true,
      });
      return 'Pacchetti approvati: l’agente potrà aggiungerli dal prossimo messaggio.';
    });
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
        <label class="visually-hidden" for="cms-dev-changeset">
          Modifica su cui lavorare
        </label>
        <select
          id="cms-dev-changeset"
          class="chat-history"
          value={selectedId ?? ''}
          disabled={busy}
          onChange={(event) => void choose((event.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">Scegli una modifica…</option>
          {changesets.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title.slice(0, 40)} · {STATUS_LABEL[c.status] ?? c.status}
            </option>
          ))}
        </select>
      </div>
      {list.error && (
        <p class="status status-error" role="alert">
          {list.error}
        </p>
      )}

      <form
        class="chat-new"
        onSubmit={(event) => {
          event.preventDefault();
          open();
        }}
      >
        <label class="visually-hidden" for="cms-dev-title">
          Titolo della nuova modifica
        </label>
        <input
          id="cms-dev-title"
          class="chat-input"
          type="text"
          maxLength={200}
          value={title}
          placeholder="Nuova modifica: es. «Calendario degli eventi»"
          disabled={create.busy}
          onInput={(event) => setTitle((event.currentTarget as HTMLInputElement).value)}
        />
        <button
          type="submit"
          class="button secondary small"
          disabled={create.busy || !title.trim()}
        >
          {create.busy ? 'Preparo…' : 'Crea'}
        </button>
      </form>
      <Status outcome={create.outcome} />

      {selected && (
        <p class="chat-selected">
          <a href={selected.previewUrl} target="_blank" rel="noreferrer">
            Apri l'anteprima
          </a>{' '}
          · controlli e pubblicazione nella scheda Sviluppo
        </p>
      )}

      <div
        class="chat-log"
        ref={log}
        role="log"
        aria-live="polite"
        aria-label="Conversazione con l'agente sviluppatore"
        tabIndex={0}
      >
        {state.messages.length === 0 && (
          <p class="muted">
            {selected
              ? "Descrivi all'agente cosa costruire: scriverà il codice in una copia del sito, senza toccare la produzione."
              : 'Scegli una modifica o creane una nuova per parlare con l’agente sviluppatore.'}
          </p>
        )}
        {state.messages.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
      </div>

      <p class="chat-phase" role="status" aria-live="polite">
        {phaseText}
      </p>
      {state.error && (
        <p class="status status-error" role="alert">
          {state.error}
        </p>
      )}

      {selected && (
        <details class="chat-deps" open={state.dependencyNeeded}>
          <summary>
            {state.dependencyNeeded
              ? "L'agente ha bisogno di un nuovo pacchetto: approvalo"
              : 'Approva nuovi pacchetti'}
          </summary>
          <p class="muted">
            L'agente aggiunge dipendenze solo se le approvi tu, con il nome del pacchetto (senza
            versione né indirizzi).
          </p>
          <form
            class="chat-new"
            onSubmit={(event) => {
              event.preventDefault();
              approvePackages();
            }}
          >
            <label class="visually-hidden" for="cms-dev-packages">
              Pacchetti da approvare
            </label>
            <input
              id="cms-dev-packages"
              class="chat-input"
              type="text"
              value={packages}
              placeholder="es. zod, date-fns"
              onInput={(event) => setPackages((event.currentTarget as HTMLInputElement).value)}
            />
            <button
              type="submit"
              class="button secondary small"
              disabled={approve.busy || parsePackageNames(packages).length === 0}
            >
              Approva
            </button>
          </form>
          <Status outcome={approve.outcome} />
        </details>
      )}

      <form
        class="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label class="visually-hidden" for="cms-dev-input">
          Messaggio per l'agente sviluppatore
        </label>
        <textarea
          id="cms-dev-input"
          class="chat-input"
          rows={3}
          value={draft}
          disabled={!selected}
          placeholder="Scrivi all'agente… (Invio per inviare, Maiusc+Invio per andare a capo)"
          onInput={(event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div class="actions">
          {busy ? (
            <button type="button" class="button secondary" onClick={() => abort.current?.abort()}>
              Ferma
            </button>
          ) : (
            <button type="submit" class="button" disabled={!selected || draft.trim() === ''}>
              Invia
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
