import { useEffect, useState } from 'preact/hooks';
import type { Api, PageStatus } from '../api.ts';
import { PAGES_ROOT, pageStateLabel, pageUrlOf, parentFromUrl, slugify } from '../format.ts';
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
  type Outcome,
} from './common.tsx';

interface TreeEntry {
  path: string;
  name: string;
  kind: string;
  url: string | null;
  title: string | null;
  hasChildren: boolean;
  version: number;
  status: PageStatus;
}

interface SharedEntry {
  name: string;
  path: string;
  status: PageStatus;
}

interface SiteSettings {
  name: string;
  lang: string;
  titleTemplate: string;
  [key: string]: unknown;
}

interface SiteOverview {
  settings: { value: SiteSettings | null; version: number | null; status: PageStatus };
  layouts: SharedEntry[];
  menus: SharedEntry[];
}

const HOME = '/site/pages/index';

function withHookWarning(result: { hookError?: string }, done: string): Outcome {
  return result.hookError
    ? { kind: 'warning', text: `${done} Il sito però non si è aggiornato: ${result.hookError}.` }
    : { kind: 'ok', text: done };
}

/** Site tab (E7.8): page tree, site settings, menus and layouts. */
export function SiteTab() {
  const { api } = useWidget();
  const action = useAction();
  const overview = useLoad(() => api.get<SiteOverview>('/site'), [api]);
  return (
    <div class="stack">
      <Status outcome={action.outcome} />
      <PageTree api={api} action={action} />
      <SettingsSection api={api} loaded={overview} />
      <SharedSection loaded={overview} />
    </div>
  );
}

type Action = ReturnType<typeof useAction>;

interface TreeState {
  api: Api;
  action: Action;
  generation: number;
  refresh: () => void;
  expanded: Set<string>;
  toggle: (path: string, open?: boolean) => void;
}

function PageTree({ api, action }: { api: Api; action: Action }) {
  const { reload } = useWidget();
  const [generation, setGeneration] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const tree: TreeState = {
    api,
    action,
    generation,
    refresh: () => {
      setGeneration((g) => g + 1);
      // The current page may have been created, renamed or deleted.
      void reload();
    },
    expanded,
    toggle: (path, open) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (open ?? !next.has(path)) next.add(path);
        else next.delete(path);
        return next;
      }),
  };
  return (
    <Section
      title="Pagine"
      actions={
        <button
          type="button"
          class="button secondary small"
          aria-expanded={creating}
          onClick={() => setCreating(!creating)}
        >
          Nuova pagina
        </button>
      }
    >
      {creating && (
        <NewPageForm tree={tree} parent={PAGES_ROOT} onDone={() => setCreating(false)} />
      )}
      <Branch tree={tree} path={PAGES_ROOT} />
    </Section>
  );
}

function Branch({ tree, path }: { tree: TreeState; path: string }) {
  const loaded = useLoad(
    () => tree.api.get<{ entries: TreeEntry[] }>('/tree', { path }),
    [tree.api, path, tree.generation],
  );
  return (
    <LoadState loaded={loaded}>
      {({ entries }) =>
        entries.length === 0 ? (
          <p class="muted tree-empty">Nessuna pagina.</p>
        ) : (
          <ul class="tree">
            {entries.map((entry) => (
              <TreeItem key={entry.path} tree={tree} entry={entry} />
            ))}
          </ul>
        )
      }
    </LoadState>
  );
}

type Mode = 'menu' | 'new' | 'rename' | 'move' | null;

function TreeItem({ tree, entry }: { tree: TreeState; entry: TreeEntry }) {
  const [mode, setMode] = useState<Mode>(null);
  const open = tree.expanded.has(entry.path);
  const state = pageStateLabel(entry.status);
  const label = entry.title || (entry.path === HOME ? 'Home' : entry.name);
  const current = typeof location !== 'undefined' && entry.url === location.pathname;
  const protectedPage = entry.path === HOME;

  const remove = () =>
    void tree.action.run(async () => {
      const result = await tree.api.send<{ hookError?: string }>('POST', '/pages/delete', {
        path: entry.path,
        expectedVersion: entry.version,
      });
      tree.refresh();
      return withHookWarning(result, `Pagina "${label}" eliminata.`);
    });

  return (
    <li class="tree-item">
      <div class={`tree-row${current ? ' current' : ''}`}>
        {entry.hasChildren ? (
          <button
            type="button"
            class="tree-toggle"
            aria-expanded={open}
            aria-label={`${open ? 'Comprimi' : 'Espandi'} ${entry.name}`}
            onClick={() => tree.toggle(entry.path)}
          >
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          </button>
        ) : (
          <span class="tree-toggle" aria-hidden="true" />
        )}
        <span class="tree-label">
          {entry.url ? (
            <a href={entry.url} aria-current={current ? 'page' : undefined}>
              {label}
            </a>
          ) : (
            label
          )}
          <span class="tree-url">{entry.url}</span>
        </span>
        <span class={`badge tone-${state.tone}`} title={state.label}>
          <span class="visually-hidden">Stato: </span>
          {entry.status.publishedVersion === null
            ? 'Bozza'
            : entry.status.hasDraft
              ? 'Modificata'
              : 'Online'}
        </span>
        <button
          type="button"
          class="icon-button small"
          aria-expanded={mode !== null}
          aria-label={`Azioni per ${entry.name}`}
          title="Azioni"
          onClick={() => setMode(mode === null ? 'menu' : null)}
        >
          <svg class="dots" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1.2" />
            <circle cx="8" cy="8" r="1.2" />
            <circle cx="12.5" cy="8" r="1.2" />
          </svg>
        </button>
      </div>
      {mode !== null && (
        <div class="tree-actions">
          {mode === 'menu' && (
            <div class="actions">
              <button type="button" class="button secondary small" onClick={() => setMode('new')}>
                Nuova sottopagina
              </button>
              {!protectedPage && (
                <>
                  <button
                    type="button"
                    class="button secondary small"
                    onClick={() => setMode('rename')}
                  >
                    Rinomina
                  </button>
                  <button
                    type="button"
                    class="button secondary small"
                    onClick={() => setMode('move')}
                  >
                    Sposta
                  </button>
                  <ConfirmButton
                    small
                    label="Elimina"
                    question={
                      entry.hasChildren
                        ? 'Eliminare la pagina e le pagine al suo interno?'
                        : 'Eliminare la pagina?'
                    }
                    confirmLabel="Elimina"
                    disabled={tree.action.busy}
                    onConfirm={remove}
                  />
                </>
              )}
            </div>
          )}
          {mode === 'new' && (
            <NewPageForm
              tree={tree}
              parent={entry.path}
              onDone={(created) => {
                setMode(null);
                if (created) tree.toggle(entry.path, true);
              }}
            />
          )}
          {mode === 'rename' && (
            <RenameForm tree={tree} entry={entry} onDone={() => setMode(null)} />
          )}
          {mode === 'move' && <MoveForm tree={tree} entry={entry} onDone={() => setMode(null)} />}
        </div>
      )}
      {open && entry.hasChildren && (
        <div class="tree-children">
          <Branch tree={tree} path={entry.path} />
        </div>
      )}
    </li>
  );
}

function NewPageForm({
  tree,
  parent,
  onDone,
}: {
  tree: TreeState;
  parent: string;
  onDone: (created: boolean) => void;
}) {
  const [title, setTitle] = useState('');
  const [name, setName] = useState('');
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!edited) setName(slugify(title));
  }, [title, edited]);

  const submit = (event: Event) => {
    event.preventDefault();
    void tree.action
      .run(async () => {
        const created = await tree.api.send<{ url: string }>('POST', '/pages', {
          parent,
          name,
          title,
        });
        tree.refresh();
        return `Pagina ${created.url} creata come bozza.`;
      })
      .then((ok) => ok && onDone(true));
  };

  return (
    <form class="form inline-form" onSubmit={submit}>
      <div class="form-row">
        <Field label="Titolo">
          {(props) => (
            <input
              {...props}
              type="text"
              required
              value={title}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
          )}
        </Field>
        <Field label="Indirizzo" hint="Minuscole, cifre e trattini.">
          {(props) => (
            <input
              {...props}
              type="text"
              required
              pattern="[a-z0-9][a-z0-9_\-]*"
              value={name}
              onInput={(e) => {
                setEdited(true);
                setName(e.currentTarget.value);
              }}
            />
          )}
        </Field>
      </div>
      <div class="actions">
        <button type="submit" class="button small" disabled={tree.action.busy}>
          Crea pagina
        </button>
        <button type="button" class="button secondary small" onClick={() => onDone(false)}>
          Annulla
        </button>
      </div>
    </form>
  );
}

function RenameForm({
  tree,
  entry,
  onDone,
}: {
  tree: TreeState;
  entry: TreeEntry;
  onDone: () => void;
}) {
  const [name, setName] = useState(entry.name);
  const submit = (event: Event) => {
    event.preventDefault();
    void tree.action
      .run(async () => {
        const result = await tree.api.send<{ path: string; hookError?: string }>(
          'POST',
          '/pages/rename',
          { path: entry.path, name, expectedVersion: entry.version },
        );
        tree.refresh();
        return withHookWarning(
          result,
          `Pagina rinominata: ora è ${pageUrlOf(result.path) ?? result.path}.`,
        );
      })
      .then((ok) => ok && onDone());
  };
  return (
    <form class="form inline-form" onSubmit={submit}>
      <Field
        label="Nuovo indirizzo"
        hint="Cambia l'URL della pagina e delle pagine al suo interno."
      >
        {(props) => (
          <input
            {...props}
            type="text"
            required
            pattern="[a-z0-9][a-z0-9_\-]*"
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        )}
      </Field>
      <div class="actions">
        <button type="submit" class="button small" disabled={tree.action.busy}>
          Rinomina
        </button>
        <button type="button" class="button secondary small" onClick={onDone}>
          Annulla
        </button>
      </div>
    </form>
  );
}

function MoveForm({
  tree,
  entry,
  onDone,
}: {
  tree: TreeState;
  entry: TreeEntry;
  onDone: () => void;
}) {
  const [destination, setDestination] = useState('');
  const submit = (event: Event) => {
    event.preventDefault();
    const parent = parentFromUrl(destination);
    if (!parent) {
      tree.action.setOutcome({
        kind: 'error',
        text: 'Indirizzo di destinazione non valido: usa ad esempio /progetti.',
      });
      return;
    }
    void tree.action
      .run(async () => {
        const result = await tree.api.send<{ path: string; hookError?: string }>(
          'POST',
          '/pages/move',
          { path: entry.path, parent, expectedVersion: entry.version },
        );
        tree.refresh();
        return withHookWarning(
          result,
          `Pagina spostata: ora è ${pageUrlOf(result.path) ?? result.path}.`,
        );
      })
      .then((ok) => ok && onDone());
  };
  return (
    <form class="form inline-form" onSubmit={submit}>
      <Field
        label="Sposta dentro la pagina"
        hint="Indirizzo della pagina che la conterrà, es. /progetti. Vuoto: livello principale."
      >
        {(props) => (
          <input
            {...props}
            type="text"
            placeholder="/progetti"
            value={destination}
            onInput={(e) => setDestination(e.currentTarget.value)}
          />
        )}
      </Field>
      <div class="actions">
        <button type="submit" class="button small" disabled={tree.action.busy}>
          Sposta
        </button>
        <button type="button" class="button secondary small" onClick={onDone}>
          Annulla
        </button>
      </div>
    </form>
  );
}

function SettingsSection({ api, loaded }: { api: Api; loaded: Loaded<SiteOverview> }) {
  return (
    <Section title="Impostazioni del sito">
      <LoadState loaded={loaded}>
        {(overview) => <SettingsForm api={api} overview={overview} reload={loaded.reload} />}
      </LoadState>
    </Section>
  );
}

function SettingsForm({
  api,
  overview,
  reload,
}: {
  api: Api;
  overview: SiteOverview;
  reload: () => Promise<void>;
}) {
  const action = useAction();
  const initial = overview.settings.value ?? { name: '', lang: 'it', titleTemplate: '%s' };
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(overview.settings.value ?? initial), [overview]);
  const set = (key: 'name' | 'lang' | 'titleTemplate') => (event: Event) =>
    setForm({ ...form, [key]: (event.currentTarget as HTMLInputElement).value });

  const save = (event: Event) => {
    event.preventDefault();
    void action.run(async () => {
      const result = await api.send<{ version: number; hookError?: string }>('PUT', '/site', {
        settings: form,
        expectedVersion: overview.settings.version ?? 0,
      });
      await reload();
      return withHookWarning(result, 'Impostazioni salvate e pubblicate.');
    });
  };

  const preview = form.titleTemplate.includes('%s')
    ? form.titleTemplate.replace('%s', 'Chi siamo')
    : null;

  return (
    <form class="form" onSubmit={save}>
      <Field label="Nome del sito">
        {(props) => (
          <input
            {...props}
            type="text"
            required
            maxLength={200}
            value={form.name}
            onInput={set('name')}
          />
        )}
      </Field>
      <div class="form-row">
        <Field label="Lingua" hint='Codice della lingua, es. "it" o "en-GB".'>
          {(props) => (
            <input
              {...props}
              type="text"
              required
              maxLength={20}
              value={form.lang}
              onInput={set('lang')}
            />
          )}
        </Field>
        <Field
          label="Modello del titolo"
          hint={
            preview
              ? `"%s" è il titolo della pagina, es. "${preview}".`
              : 'Deve contenere "%s", il titolo della pagina.'
          }
        >
          {(props) => (
            <input
              {...props}
              type="text"
              required
              maxLength={200}
              value={form.titleTemplate}
              onInput={set('titleTemplate')}
            />
          )}
        </Field>
      </div>
      <div class="actions">
        <button type="submit" class="button" disabled={action.busy}>
          Salva e pubblica
        </button>
      </div>
      <Status outcome={action.outcome} />
    </form>
  );
}

const LAYOUT_LABEL: Record<string, string> = {
  header: 'Intestazione (header)',
  footer: 'Piè di pagina (footer)',
};

function SharedSection({ loaded }: { loaded: Loaded<SiteOverview> }) {
  return (
    <Section title="Menu e layout">
      <LoadState loaded={loaded}>
        {({ layouts, menus }) => (
          <>
            {layouts.length + menus.length === 0 ? (
              <p class="muted">Il sito non ha ancora intestazione, piè di pagina o menu.</p>
            ) : (
              <ul class="shared-list">
                {layouts.map((item) => (
                  <SharedItem key={item.path} item={item} label={LAYOUT_LABEL[item.name]} />
                ))}
                {menus.map((item) => (
                  <SharedItem
                    key={item.path}
                    item={item}
                    label={item.name === 'main' ? 'Menu principale' : `Menu "${item.name}"`}
                  />
                ))}
              </ul>
            )}
            <p class="hint">
              Si modificano dalla chat, ad esempio: «Aggiungi la pagina Contatti al menu principale»
              oppure «Metti il telefono nel piè di pagina».
            </p>
          </>
        )}
      </LoadState>
    </Section>
  );
}

function SharedItem({ item, label }: { item: SharedEntry; label?: string }) {
  const state = pageStateLabel(item.status);
  return (
    <li class="shared-item">
      <span>
        {label ?? item.name} <code>{item.path}</code>
      </span>
      <span class={`badge tone-${state.tone}`}>{state.label}</span>
    </li>
  );
}
