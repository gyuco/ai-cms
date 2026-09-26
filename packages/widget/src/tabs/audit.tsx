import { useState } from 'preact/hooks';
import { SHORT_DATE_TIME, formatDateTime, outcomeLabel, plural } from '../format.ts';
import { useWidget } from '../widget-context.ts';
import { Field, Section, Status, errorMessage, useLoad } from './common.tsx';

interface AuditEntry {
  id: number;
  at: string;
  actorUid: number;
  actor: string | null;
  agent: string | null;
  action: string;
  nodePath: string | null;
  env: string | null;
  outcome: string;
  details: unknown;
}

interface AuditPage {
  entries: AuditEntry[];
  nextCursor: number | null;
}

interface Filters {
  actor: string;
  action: string;
  path: string;
  outcome: string;
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { actor: '', action: '', path: '', outcome: '', from: '', to: '' };

const OUTCOMES = ['ok', 'allowed', 'denied', 'error'];

/** Audit tab (E7.12): the log, filtered and paged, newest first. */
export function AuditTab() {
  const { api } = useWidget();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [more, setMore] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const active = Object.values(filters).filter(Boolean).length;
  const [moreError, setMoreError] = useState<string | null>(null);

  const first = useLoad(async () => {
    const page = await api.get<AuditPage>('/audit', { ...filters });
    setMore([]);
    setCursor(page.nextCursor);
    return page;
  }, [api, filters]);

  const set = (key: keyof Filters) => (event: Event) =>
    setDraft({ ...draft, [key]: (event.currentTarget as HTMLInputElement).value });
  const apply = (event: Event) => {
    event.preventDefault();
    setFilters({ ...draft });
  };
  const reset = () => {
    setDraft(NO_FILTERS);
    setFilters(NO_FILTERS);
  };
  const loadMore = async () => {
    if (cursor === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.get<AuditPage>('/audit', { ...filters, cursor });
      setMore((current) => [...current, ...page.entries]);
      setCursor(page.nextCursor);
    } catch (err) {
      setMoreError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const entries = [...(first.data?.entries ?? []), ...more];

  return (
    <Section
      title="Registro delle azioni"
      actions={
        <button
          type="button"
          class="button secondary small"
          aria-expanded={showFilters}
          aria-controls="cms-audit-filters"
          onClick={() => setShowFilters(!showFilters)}
        >
          Filtri{active > 0 ? ` (${String(active)})` : ''}
        </button>
      }
    >
      {showFilters && (
        <form id="cms-audit-filters" class="form audit-filters" onSubmit={apply}>
          <div class="form-row">
            <Field label="Utente">
              {(props) => (
                <input {...props} type="text" value={draft.actor} onInput={set('actor')} />
              )}
            </Field>
            <Field label="Azione" hint="Anche l'inizio, es. content.">
              {(props) => (
                <input {...props} type="text" value={draft.action} onInput={set('action')} />
              )}
            </Field>
          </div>
          <div class="form-row">
            <Field label="Nodo" hint="Include i nodi al suo interno.">
              {(props) => (
                <input
                  {...props}
                  type="text"
                  placeholder="/site/pages"
                  value={draft.path}
                  onInput={set('path')}
                />
              )}
            </Field>
            <Field label="Esito">
              {(props) => (
                <select {...props} value={draft.outcome} onChange={set('outcome')}>
                  <option value="">Tutti</option>
                  {OUTCOMES.map((outcome) => (
                    <option key={outcome} value={outcome}>
                      {outcomeLabel(outcome).label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <div class="form-row">
            <Field label="Dal">
              {(props) => <input {...props} type="date" value={draft.from} onInput={set('from')} />}
            </Field>
            <Field label="Al">
              {(props) => <input {...props} type="date" value={draft.to} onInput={set('to')} />}
            </Field>
          </div>
          <div class="actions">
            <button type="submit" class="button small">
              Filtra
            </button>
            <button type="button" class="button secondary small" onClick={reset}>
              Azzera
            </button>
          </div>
        </form>
      )}
      {first.error ? (
        <Status outcome={{ kind: 'error', text: first.error }} />
      ) : !first.data ? (
        <p class="muted" role="status">
          Caricamento…
        </p>
      ) : (
        <>
          <p class="muted" role="status" aria-live="polite">
            {entries.length === 0
              ? 'Nessuna voce con questi filtri.'
              : `${plural(entries.length, 'voce', 'voci')}${cursor !== null ? ', altre disponibili' : ''}.`}
          </p>
          {entries.length > 0 && <AuditTable entries={entries} />}
          {cursor !== null && (
            <div class="actions">
              <button
                type="button"
                class="button secondary small"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? 'Caricamento…' : 'Carica altre voci'}
              </button>
            </div>
          )}
          <Status outcome={moreError ? { kind: 'error', text: moreError } : null} />
        </>
      )}
    </Section>
  );
}

/** A path that may wrap after each "/". */
function breakable(path: string) {
  return path.split('/').map((part, index) => (
    <>
      {index > 0 && (
        <>
          /<wbr />
        </>
      )}
      {part}
    </>
  ));
}

function AuditTable({ entries }: { entries: AuditEntry[] }) {
  return (
    <div class="table-wrap">
      <table class="audit-table">
        <thead>
          <tr>
            <th scope="col">Quando</th>
            <th scope="col">Chi</th>
            <th scope="col">Azione</th>
            <th scope="col">Esito</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const outcome = outcomeLabel(entry.outcome);
            return (
              <tr key={entry.id}>
                <td>
                  <time dateTime={entry.at} title={formatDateTime(entry.at)}>
                    {formatDateTime(entry.at, SHORT_DATE_TIME)}
                  </time>
                  {entry.env && <span class="audit-sub">{entry.env}</span>}
                </td>
                <td>
                  {entry.actor ?? `uid ${String(entry.actorUid)}`}
                  {entry.agent && <span class="audit-sub">tramite {entry.agent}</span>}
                </td>
                <td>
                  {entry.details ? (
                    <details>
                      <summary>
                        <code>{entry.action}</code>
                      </summary>
                      <pre>{JSON.stringify(entry.details, null, 2)}</pre>
                    </details>
                  ) : (
                    <code>{entry.action}</code>
                  )}
                  {entry.nodePath && <span class="audit-sub">{breakable(entry.nodePath)}</span>}
                </td>
                <td>
                  <span class={`badge tone-${outcome.tone}`}>{outcome.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
