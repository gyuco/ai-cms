import { useEffect, useState } from 'preact/hooks';
import type { Api, NodeInfo, PageStatus } from '../api.ts';
import { formatDateTime, pageStateLabel, pageUrlOf, plural, splitNodePath } from '../format.ts';
import { useWidget } from '../widget-context.ts';
import {
  ConfirmButton,
  Field,
  LoadState,
  Section,
  Status,
  useAction,
  useLoad,
  type Outcome,
} from './common.tsx';

interface PageMeta {
  title?: string;
  description?: string;
  og?: { title?: string; description?: string; image?: string };
  [key: string]: unknown;
}

interface VersionInfo {
  version: number;
  authorName: string | null;
  viaAgent: string | null;
  createdAt: string;
  published: boolean;
}

interface PageDetails {
  node: { path: string; url: string | null; version: number };
  status: PageStatus;
  meta: PageMeta;
  versions: VersionInfo[];
}

interface Violation {
  rule: string;
  message: string;
  selector?: string;
}

type ValidationResult =
  | {
      status: 'checked';
      report: { ok: boolean; errors: Violation[]; warnings: Violation[] };
    }
  | { status: 'unavailable'; message: string };

interface PublishResult {
  hookError?: string;
}

/** Page tab (E7.7): metadata, state, versions and HTML rules of the current page. */
export function PageTab() {
  const { context } = useWidget();
  // Survives the switch from "missing" to the editor once the page is created.
  const [created, setCreated] = useState<Outcome>(null);
  const node = context.node;
  if (!node) {
    return <p class="muted">Cambia la password per gestire le pagine.</p>;
  }
  if (node.path === null) {
    return (
      <p class="muted">
        Questo indirizzo non corrisponde a una pagina del sito: gli indirizzi delle pagine usano
        solo lettere minuscole, cifre, "-" e "_".
      </p>
    );
  }
  if (!node.exists) return <MissingPage node={node} path={node.path} onCreated={setCreated} />;
  if (node.kind !== 'page') {
    return (
      <p class="muted">
        L'indirizzo corrisponde a <code>{node.path}</code>, che non è una pagina (tipo "{node.kind}
        ").
      </p>
    );
  }
  return <PageEditor path={node.path} initial={created} />;
}

function MissingPage({
  node,
  path,
  onCreated,
}: {
  node: NodeInfo;
  path: string;
  onCreated: (outcome: Outcome) => void;
}) {
  const { api, reload } = useWidget();
  const action = useAction();
  const [title, setTitle] = useState('');
  const parts = splitNodePath(path);

  const create = (event: Event) => {
    event.preventDefault();
    if (!parts) return;
    void action.run(async () => {
      await api.send('POST', '/pages', { parent: parts.parent, name: parts.name, title });
      const done: Outcome = { kind: 'ok', text: 'Pagina creata come bozza.' };
      onCreated(done);
      await reload();
      return done;
    });
  };

  return (
    <div class="stack">
      <Section title="Pagina non trovata">
        <p>
          La pagina <code>{node.path}</code> non esiste ancora. Puoi crearla ora: nasce vuota e in
          bozza, poi la completi dalla chat e la pubblichi.
        </p>
        <form class="form" onSubmit={create}>
          <Field label="Titolo della pagina" hint="Facoltativo: puoi cambiarlo in seguito.">
            {(props) => (
              <input
                {...props}
                type="text"
                value={title}
                maxLength={200}
                onInput={(e) => setTitle(e.currentTarget.value)}
              />
            )}
          </Field>
          <div class="actions">
            <button type="submit" class="button" disabled={action.busy || !parts}>
              Crea questa pagina
            </button>
          </div>
        </form>
      </Section>
      <Status outcome={action.outcome} />
    </div>
  );
}

function PageEditor({ path, initial }: { path: string; initial: Outcome }) {
  const { api, reload: reloadContext } = useWidget();
  const loaded = useLoad(() => api.get<PageDetails>('/pages', { path }), [api, path]);
  const action = useAction(initial);

  const refresh = async () => {
    await Promise.all([loaded.reload(), reloadContext()]);
  };

  return (
    <LoadState loaded={loaded}>
      {(details) => (
        <div class="stack">
          <Status outcome={action.outcome} />
          <StateSection details={details} api={api} action={action} refresh={refresh} />
          <MetaSection details={details} api={api} action={action} refresh={refresh} />
          <RulesSection url={details.node.url ?? pageUrlOf(details.node.path)} api={api} />
          <VersionsSection details={details} api={api} action={action} refresh={refresh} />
        </div>
      )}
    </LoadState>
  );
}

interface SectionProps {
  details: PageDetails;
  api: Api;
  action: ReturnType<typeof useAction>;
  refresh: () => Promise<void>;
}

function publishedOutcome(result: PublishResult, done: string): Outcome {
  return result.hookError
    ? { kind: 'warning', text: `${done} Il sito però non si è aggiornato: ${result.hookError}.` }
    : { kind: 'ok', text: done };
}

function StateSection({ details, api, action, refresh }: SectionProps) {
  const { status, node } = details;
  const state = pageStateLabel(status);
  const publish = () =>
    action.run(async () => {
      const result = await api.send<PublishResult>('POST', '/pages/publish', { path: node.path });
      await refresh();
      return publishedOutcome(result, `Versione ${String(status.latestVersion)} pubblicata.`);
    });
  const unpublish = () => {
    void action.run(async () => {
      const result = await api.send<PublishResult>('POST', '/pages/unpublish', {
        path: node.path,
      });
      await refresh();
      return publishedOutcome(result, 'Pagina ritirata dal sito.');
    });
  };

  return (
    <Section title="Stato">
      <p class="state-line">
        <span class={`badge tone-${state.tone}`}>{state.label}</span>
        <span class="muted">
          {status.publishedVersion !== null && `Online: versione ${status.publishedVersion}. `}
          {status.latestVersion !== null && `Ultima: versione ${status.latestVersion}.`}
        </span>
      </p>
      <div class="actions">
        <button
          type="button"
          class="button"
          disabled={action.busy || !status.hasDraft}
          onClick={() => void publish()}
        >
          Pubblica
        </button>
        <ConfirmButton
          label="Ritira dal sito"
          question="I visitatori non vedranno più la pagina. Confermi?"
          confirmLabel="Ritira"
          disabled={action.busy || status.publishedVersion === null}
          onConfirm={unpublish}
        />
      </div>
    </Section>
  );
}

interface MetaForm {
  title: string;
  description: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
}

function toForm(meta: PageMeta): MetaForm {
  return {
    title: meta.title ?? '',
    description: meta.description ?? '',
    ogTitle: meta.og?.title ?? '',
    ogDescription: meta.og?.description ?? '',
    ogImage: meta.og?.image ?? '',
  };
}

function MetaSection({ details, api, action, refresh }: SectionProps) {
  const [form, setForm] = useState(() => toForm(details.meta));
  useEffect(() => setForm(toForm(details.meta)), [details]);
  const set = (key: keyof MetaForm) => (event: Event) =>
    setForm({ ...form, [key]: (event.currentTarget as HTMLInputElement).value });

  const save = (event: Event) => {
    event.preventDefault();
    void action.run(async () => {
      // Other metadata (lang, canonical, robots, …) are kept; blank fields are removed.
      const meta = {
        ...details.meta,
        title: form.title,
        description: form.description,
        og: {
          ...details.meta.og,
          title: form.ogTitle,
          description: form.ogDescription,
          image: form.ogImage,
        },
      };
      const result = await api.send<{ version: number }>('PATCH', '/pages', {
        path: details.node.path,
        meta,
        expectedVersion: details.status.latestVersion ?? 0,
      });
      await refresh();
      return `Metadati salvati nella bozza (versione ${String(result.version)}).`;
    });
  };

  return (
    <Section title="Titolo e metadati">
      <form class="form" onSubmit={save}>
        <Field label="Titolo" hint="Compare nella scheda del browser e nei risultati di ricerca.">
          {(props) => (
            <input
              {...props}
              type="text"
              value={form.title}
              maxLength={200}
              onInput={set('title')}
            />
          )}
        </Field>
        <Field label="Descrizione" hint="Tra 50 e 160 caratteri, per i motori di ricerca.">
          {(props) => (
            <textarea
              {...props}
              rows={2}
              value={form.description}
              maxLength={800}
              onInput={set('description')}
            />
          )}
        </Field>
        <fieldset class="fieldset">
          <legend>Condivisione sui social</legend>
          <Field label="Titolo social" hint="Se vuoto si usa il titolo della pagina.">
            {(props) => (
              <input
                {...props}
                type="text"
                value={form.ogTitle}
                maxLength={200}
                onInput={set('ogTitle')}
              />
            )}
          </Field>
          <Field label="Descrizione social">
            {(props) => (
              <textarea
                {...props}
                rows={2}
                value={form.ogDescription}
                maxLength={800}
                onInput={set('ogDescription')}
              />
            )}
          </Field>
          <Field label="Immagine social" hint="Indirizzo dell'immagine, es. /_cms/assets/…">
            {(props) => (
              <input {...props} type="text" value={form.ogImage} onInput={set('ogImage')} />
            )}
          </Field>
        </fieldset>
        <div class="actions">
          <button type="submit" class="button" disabled={action.busy}>
            Salva in bozza
          </button>
        </div>
      </form>
    </Section>
  );
}

function RulesSection({ url, api }: { url: string | null; api: Api }) {
  const action = useAction();
  const [result, setResult] = useState<ValidationResult | null>(null);
  if (!url) return null;

  const check = () =>
    action.run(async () => {
      const checked = await api.send<ValidationResult>('POST', '/pages/validate', { url });
      setResult(checked);
      if (checked.status === 'unavailable') return { kind: 'warning', text: checked.message };
      const { errors, warnings } = checked.report;
      if (errors.length === 0 && warnings.length === 0)
        return 'Nessun problema: la pagina rispetta le regole HTML.';
      return {
        kind: errors.length > 0 ? 'error' : 'warning',
        text: `${plural(errors.length, 'errore', 'errori')}, ${plural(warnings.length, 'avviso', 'avvisi')}.`,
      };
    });

  return (
    <Section title="Regole HTML">
      <p class="hint">Verifica la pagina com'è pubblicata ora su questo ambiente.</p>
      <div class="actions">
        <button
          type="button"
          class="button secondary"
          disabled={action.busy}
          onClick={() => void check()}
        >
          {action.busy ? 'Verifica in corso…' : 'Verifica le regole HTML'}
        </button>
      </div>
      <Status outcome={action.outcome} />
      {result?.status === 'checked' && (
        <>
          {result.report.errors.length > 0 && (
            <ViolationList
              title="Errori (bloccano la pubblicazione)"
              items={result.report.errors}
              tone="error"
            />
          )}
          {result.report.warnings.length > 0 && (
            <ViolationList title="Avvisi" items={result.report.warnings} tone="warning" />
          )}
        </>
      )}
    </Section>
  );
}

function ViolationList({
  title,
  items,
  tone,
}: {
  title: string;
  items: Violation[];
  tone: 'error' | 'warning';
}) {
  return (
    <div class={`violations tone-${tone}`}>
      <h4 class="subtitle">{title}</h4>
      <ul class="plain-list">
        {items.map((item, index) => (
          <li key={index}>
            {item.message}
            {item.selector && <code class="selector">{item.selector}</code>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function VersionsSection({ details, api, action, refresh }: SectionProps) {
  const restore = (version: number) =>
    action.run(async () => {
      const result = await api.send<{ version: number }>('POST', '/pages/restore', {
        path: details.node.path,
        version,
        expectedVersion: details.status.latestVersion ?? 0,
      });
      await refresh();
      return `Versione ${String(version)} ripristinata come nuova bozza (versione ${String(result.version)}).`;
    });

  return (
    <Section title={`Versioni (${String(details.versions.length)})`}>
      {details.versions.length === 0 ? (
        <p class="muted">Nessuna versione salvata.</p>
      ) : (
        <ol class="version-list">
          {details.versions.map((v) => (
            <li key={v.version} class="version">
              <span class="version-number">v{v.version}</span>
              <span class="version-meta">
                <time dateTime={v.createdAt}>{formatDateTime(v.createdAt)}</time>
                {' · '}
                {v.authorName ?? 'utente eliminato'}
                {v.viaAgent && <span class="muted"> tramite {v.viaAgent}</span>}
              </span>
              {v.published && <span class="badge tone-ok">Online</span>}
              {v.version !== details.status.latestVersion && (
                <button
                  type="button"
                  class="button secondary small"
                  disabled={action.busy}
                  aria-label={`Ripristina la versione ${String(v.version)}`}
                  onClick={() => void restore(v.version)}
                >
                  Ripristina
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
