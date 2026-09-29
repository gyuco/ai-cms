import { useEffect, useRef, useState } from 'preact/hooks';
import {
  autofixLabel,
  changesetStatusLabel,
  checkNameLabel,
  checkStatusLabel,
  isBusyStatus,
  personName,
  releaseStatusLabel,
  type AutofixState,
} from '../dev-format.ts';
import { SHORT_DATE_TIME, formatDateTime, plural } from '../format.ts';
import { useWidget } from '../widget-context.ts';
import {
  ConfirmButton,
  Field,
  LoadState,
  Section,
  Status,
  useAction,
  useLoad,
  type Loaded,
} from './common.tsx';

interface Person {
  uid: number;
  username: string;
  displayName: string | null;
}

interface OpenChangeset {
  id: string;
  title: string;
  status: string;
  author: Person | null;
  headCommit: string | null;
  destructiveMigration: boolean;
  updatedAt: string;
  previewUrl: string;
}

interface CheckResult {
  name: string;
  status: string;
  output: string | null;
}

interface ChecksState {
  status: string;
  checks: CheckResult[];
  autofix: { state: AutofixState; attempts: number; maxAttempts: number };
}

interface ReleaseEntry {
  id: string;
  number: number;
  tag: string;
  status: string;
  approvedBy: Person | null;
  changesets: Array<{ id: string; title: string; author: Person | null }>;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  current: boolean;
  canRollback: boolean;
}

/** Poll period while something is moving, and while the tab only waits for news. */
const BUSY_MS = 4000;
const IDLE_MS = 20000;

/** Reloads `loaded` every `ms` while the tab is visible; `ms` null switches polling off. */
function usePolling(loaded: Loaded<unknown>, ms: number | null): void {
  const reload = useRef(loaded.reload);
  reload.current = loaded.reload;
  useEffect(() => {
    if (ms === null) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void reload.current();
    }, ms);
    return () => clearInterval(timer);
  }, [ms]);
}

/** Development tab (E7.11): open changesets, checks, approval, release history and rollback. */
export function DevTab() {
  const { api } = useWidget();
  const changesets = useLoad(() => api.get<{ changesets: OpenChangeset[] }>('/changesets'), [api]);
  const releases = useLoad(
    () => api.get<{ releases: ReleaseEntry[] }>('/releases', { limit: 20 }),
    [api],
  );
  const action = useAction();
  const busy = changesets.data?.changesets.some((c) => isBusyStatus(c.status)) ?? false;
  usePolling(changesets, busy ? BUSY_MS : IDLE_MS);
  usePolling(releases, busy ? BUSY_MS : IDLE_MS);

  const refresh = async () => {
    await Promise.all([changesets.reload(), releases.reload()]);
  };

  const approve = (changeset: OpenChangeset) =>
    void action.run(async () => {
      await api.send('POST', `/changesets/${changeset.id}/approve`, {
        confirmDestructive: changeset.destructiveMigration,
      });
      await refresh();
      return 'Approvata: la release è in coda e verrà pubblicata a breve.';
    });

  const reject = (changeset: OpenChangeset, comment: string) =>
    action.run(async () => {
      await api.send('POST', `/changesets/${changeset.id}/reject`, { comment });
      await refresh();
      return "Rifiutata: il commento è stato inviato all'agente come richiesta di modifiche.";
    });

  const rollback = (release: ReleaseEntry) =>
    void action.run(async () => {
      await api.send('POST', `/releases/${release.id}/rollback`);
      await refresh();
      return `Rollback della release ${String(release.number)} avviato: il sito torna alla release precedente.`;
    });

  return (
    <div class="stack">
      <Status outcome={action.outcome} />
      <Section title="Modifiche in corso">
        <LoadState loaded={changesets}>
          {({ changesets: list }) =>
            list.length === 0 ? (
              <p class="muted">Nessuna modifica al codice in corso.</p>
            ) : (
              <ul class="dev-list">
                {list.map((changeset) => (
                  <ChangesetItem
                    key={changeset.id}
                    changeset={changeset}
                    busy={action.busy}
                    onApprove={() => approve(changeset)}
                    onReject={(comment) => reject(changeset, comment)}
                  />
                ))}
              </ul>
            )
          }
        </LoadState>
      </Section>
      <Section title="Release">
        <LoadState loaded={releases}>
          {({ releases: list }) =>
            list.length === 0 ? (
              <p class="muted">Nessuna release pubblicata finora.</p>
            ) : (
              <ul class="dev-list">
                {list.map((release) => (
                  <ReleaseItem
                    key={release.id}
                    release={release}
                    busy={action.busy}
                    onRollback={() => rollback(release)}
                  />
                ))}
              </ul>
            )
          }
        </LoadState>
      </Section>
    </div>
  );
}

function ChangesetItem({
  changeset,
  busy,
  onApprove,
  onReject,
}: {
  changeset: OpenChangeset;
  busy: boolean;
  onApprove: () => void;
  onReject: (comment: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  const state = changesetStatusLabel(changeset.status);
  const ready = changeset.status === 'ready';

  const reject = async (event: Event) => {
    event.preventDefault();
    if (!comment.trim()) return;
    if (await onReject(comment.trim())) {
      setRejecting(false);
      setComment('');
    }
  };

  return (
    <li class="dev-item">
      <div class="dev-head">
        <span class="dev-title">
          <strong>{changeset.title}</strong>
          <span class="muted">
            {personName(changeset.author)} · {formatDateTime(changeset.updatedAt, SHORT_DATE_TIME)}
          </span>
        </span>
        <span class={`badge tone-${state.tone}`}>{state.label}</span>
      </div>
      <div class="actions">
        <button
          type="button"
          class="button secondary small"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Nascondi i controlli' : 'Mostra i controlli'}
        </button>
        <a
          class="button secondary small"
          href={changeset.previewUrl}
          target="_blank"
          rel="noopener"
        >
          Apri l'anteprima<span class="visually-hidden"> (si apre in una nuova scheda)</span>
        </a>
      </div>
      {open && <ChecksPanel changesetId={changeset.id} status={changeset.status} />}
      {ready && (
        <>
          {changeset.destructiveMigration && (
            <p class="status status-warning" role="note">
              Questa modifica contiene una migrazione distruttiva: dopo la pubblicazione alcuni dati
              potrebbero non essere più recuperabili.
            </p>
          )}
          {!rejecting && (
            <div class="actions">
              <ConfirmButton
                small
                label="Approva e pubblica"
                question={
                  changeset.destructiveMigration
                    ? 'Confermi la migrazione distruttiva e la pubblicazione?'
                    : 'Pubblicare questa modifica?'
                }
                confirmLabel={changeset.destructiveMigration ? 'Sì, pubblica' : 'Pubblica'}
                ariaLabel={`Approva e pubblica «${changeset.title}»`}
                disabled={busy}
                onConfirm={onApprove}
              />
              <button
                type="button"
                class="button secondary small"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                Rifiuta
              </button>
            </div>
          )}
          {rejecting && (
            <form class="form" onSubmit={(event) => void reject(event)}>
              <Field label="Cosa va cambiato?" hint="L'agente riceverà questo commento.">
                {(props) => (
                  <textarea
                    {...props}
                    rows={3}
                    required
                    value={comment}
                    onInput={(event) =>
                      setComment((event.currentTarget as HTMLTextAreaElement).value)
                    }
                  />
                )}
              </Field>
              <div class="actions">
                <button type="submit" class="button small" disabled={busy || !comment.trim()}>
                  Invia il rifiuto
                </button>
                <button
                  type="button"
                  class="button secondary small"
                  onClick={() => {
                    setRejecting(false);
                    setComment('');
                  }}
                >
                  Annulla
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </li>
  );
}

/** Checks of one changeset with their logs; refreshed while they are still moving. */
function ChecksPanel({ changesetId, status }: { changesetId: string; status: string }) {
  const { api } = useWidget();
  const loaded = useLoad(
    () => api.get<ChecksState>(`/changesets/${changesetId}/checks`),
    [api, changesetId, status],
  );
  const moving =
    isBusyStatus(loaded.data?.status ?? status) || loaded.data?.autofix.state === 'running';
  usePolling(loaded, moving ? BUSY_MS : null);

  return (
    <LoadState loaded={loaded}>
      {(data) => {
        const autofix = autofixLabel(data.autofix);
        return (
          <div class="dev-checks">
            {autofix && (
              <p class={data.autofix.state === 'exhausted' ? 'status status-error' : 'hint'}>
                {autofix}
              </p>
            )}
            {data.checks.length === 0 ? (
              <p class="muted" role="status">
                Nessun controllo eseguito finora.
              </p>
            ) : (
              <ul class="plain-list">
                {data.checks.map((check) => {
                  const result = checkStatusLabel(check.status);
                  return (
                    <li key={check.name} class="dev-check">
                      <span class="dev-check-head">
                        <span>{checkNameLabel(check.name)}</span>
                        <span class={`badge tone-${result.tone}`}>{result.label}</span>
                      </span>
                      {check.output && (
                        <details>
                          <summary>Log</summary>
                          <pre class="dev-log">{check.output}</pre>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      }}
    </LoadState>
  );
}

function ReleaseItem({
  release,
  busy,
  onRollback,
}: {
  release: ReleaseEntry;
  busy: boolean;
  onRollback: () => void;
}) {
  const state = releaseStatusLabel(release.status);
  return (
    <li class="dev-item">
      <div class="dev-head">
        <span class="dev-title">
          <strong>
            Release {release.number}
            {release.current && <span class="muted"> (in produzione)</span>}
          </strong>
          <span class="muted">
            {personName(release.approvedBy)} ·{' '}
            {formatDateTime(release.finishedAt ?? release.createdAt, SHORT_DATE_TIME)}
          </span>
        </span>
        <span class={`badge tone-${state.tone}`}>{state.label}</span>
      </div>
      {release.changesets.length > 0 && (
        <p class="hint">
          {plural(release.changesets.length, 'modifica', 'modifiche')}:{' '}
          {release.changesets.map((c) => c.title).join(', ')}
        </p>
      )}
      {release.error && <p class="status status-error">{release.error}</p>}
      {release.canRollback && (
        <div class="actions">
          <ConfirmButton
            small
            label="Rollback"
            question="Tornare alla release precedente? I dati del database non vengono ripristinati."
            confirmLabel="Sì, torna indietro"
            ariaLabel={`Rollback della release ${String(release.number)}`}
            disabled={busy}
            onConfirm={onRollback}
          />
        </div>
      )}
    </li>
  );
}
