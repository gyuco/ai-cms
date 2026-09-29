import { useState } from 'preact/hooks';
import type { Api } from '../api.ts';
import { formatDateTime } from '../format.ts';
import { useWidget } from '../widget-context.ts';
import {
  EMPTY_FORM,
  PROVIDER_LABEL,
  ROLE_LABEL,
  SUBSCRIPTION_LABEL,
  SUBSCRIPTION_TONE,
  TYPE_LABEL,
  connectCommand,
  connectionInput,
  fieldsFor,
  providersFor,
  rolesOf,
  subscriptionState,
  withType,
  type ConnectionForm,
  type ConnectionType,
  type ConnectionView,
  type RoleAssignment,
  type SubscriptionState,
} from './ai-form.ts';
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

interface TestResult {
  ok: boolean;
  status: 'ok' | 'error' | 'unverified';
  message: string;
  latencyMs: number;
}

type Action = ReturnType<typeof useAction>;

/** AI tab (E7.10): connections, "Prova connessione", the connection used by every role. */
export function AiTab() {
  const { api, context } = useWidget();
  const loaded = useLoad(
    () => api.get<{ connections: ConnectionView[]; roles: RoleAssignment[] }>('/ai/connections'),
    [api],
  );
  const action = useAction();
  const [adding, setAdding] = useState(false);

  return (
    <div class="stack">
      <Status outcome={action.outcome} />
      <Section
        title="Connessioni AI"
        actions={
          <button
            type="button"
            class="button secondary small"
            aria-expanded={adding}
            onClick={() => setAdding(!adding)}
          >
            Aggiungi una connessione
          </button>
        }
      >
        {adding && (
          <AddConnection
            api={api}
            action={action}
            username={context.user.username}
            onDone={async (created) => {
              if (created) await loaded.reload();
              setAdding(false);
            }}
          />
        )}
        <LoadState loaded={loaded}>
          {({ connections, roles }) =>
            connections.length === 0 ? (
              <p class="muted">
                Nessuna connessione: aggiungine una (chiave API, abbonamento Claude Code o modello
                locale) per usare la chat.
              </p>
            ) : (
              <ul class="connection-list">
                {connections.map((connection) => (
                  <ConnectionItem
                    key={connection.id}
                    api={api}
                    action={action}
                    connection={connection}
                    roles={rolesOf(roles, connection.id)}
                    username={context.user.username}
                    reload={loaded.reload}
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

function ConnectionItem({
  api,
  action,
  connection,
  roles,
  username,
  reload,
}: {
  api: Api;
  action: Action;
  connection: ConnectionView;
  roles: string[];
  username: string;
  reload: () => Promise<void>;
}) {
  const test = useAction();
  const [changingKey, setChangingKey] = useState(false);
  const active = roles.length > 0;
  const allRoles = roles.length === Object.keys(ROLE_LABEL).length;
  const id = encodeURIComponent(connection.id);
  const subscription = subscriptionState(connection);

  const runTest = () =>
    void test.run(async (): Promise<Outcome> => {
      const result = await api.send<TestResult>('POST', `/ai/connections/${id}/test`, {});
      await reload();
      return {
        kind: result.status === 'ok' ? 'ok' : result.status === 'unverified' ? 'warning' : 'error',
        text: result.message,
      };
    });
  const activate = () =>
    void action.run(async () => {
      await api.send('POST', '/ai/active', { connectionId: connection.id });
      await reload();
      return `"${connection.label}" è ora usata da tutti i ruoli AI.`;
    });
  const remove = () =>
    void action.run(async () => {
      await api.send('DELETE', `/ai/connections/${id}`);
      await reload();
      return `Connessione "${connection.label}" eliminata.`;
    });

  return (
    <li class="connection">
      <div class="connection-head">
        <strong>{connection.label}</strong>
        {allRoles ? (
          <span class="badge tone-ok">Attiva per tutti i ruoli</span>
        ) : (
          active && (
            <span class="badge tone-draft">
              Usata da: {roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}
            </span>
          )
        )}
      </div>
      <dl class="facts">
        <dt>Tipo</dt>
        <dd>
          {TYPE_LABEL[connection.type]} · {PROVIDER_LABEL[connection.provider]}
          {connection.scope === 'personal' && ' · personale'}
        </dd>
        {connection.baseUrl && (
          <>
            <dt>Indirizzo</dt>
            <dd>
              <code>{connection.baseUrl}</code>
            </dd>
          </>
        )}
        <dt>Modello</dt>
        <dd>{connection.defaultModel ?? 'predefinito'}</dd>
        {subscription && (
          <>
            <dt>Abbonamento</dt>
            <dd>
              <span class={`badge ${SUBSCRIPTION_TONE[subscription]}`}>
                {SUBSCRIPTION_LABEL[subscription]}
              </span>
            </dd>
          </>
        )}
        {connection.type !== 'subscription' && (
          <>
            <dt>Chiave</dt>
            <dd>{connection.hasKey ? <code>{connection.keyHint}</code> : 'nessuna'}</dd>
          </>
        )}
        {connection.lastTest && (
          <>
            <dt>Ultima prova</dt>
            <dd>
              {connection.lastTest.ok ? 'riuscita' : 'fallita'}
              {connection.lastTest.ok && !connection.lastTest.tools && ', senza uso di strumenti'}
              {' · '}
              {formatDateTime(connection.lastTest.at)}
            </dd>
          </>
        )}
      </dl>
      {subscription && <SubscriptionHelp username={username} state={subscription} />}
      <div class="actions">
        <button type="button" class="button secondary small" disabled={test.busy} onClick={runTest}>
          {test.busy ? 'Prova in corso…' : 'Prova connessione'}
        </button>
        {!allRoles && connection.scope === 'shared' && (
          <button type="button" class="button small" disabled={action.busy} onClick={activate}>
            Usa per tutti i ruoli
          </button>
        )}
        {connection.type !== 'subscription' && (
          <button
            type="button"
            class="button secondary small"
            aria-expanded={changingKey}
            onClick={() => setChangingKey(!changingKey)}
          >
            {connection.hasKey ? 'Cambia la chiave' : 'Aggiungi la chiave'}
          </button>
        )}
        <ConfirmButton
          small
          label="Elimina"
          ariaLabel={`Elimina ${connection.label}`}
          question={
            active ? 'È in uso: i ruoli resteranno senza connessione. Eliminarla?' : 'Eliminarla?'
          }
          confirmLabel="Elimina"
          disabled={action.busy}
          onConfirm={remove}
        />
      </div>
      {changingKey && (
        <KeyForm
          api={api}
          action={action}
          connection={connection}
          onDone={async (changed) => {
            setChangingKey(false);
            if (changed) await reload();
          }}
        />
      )}
      <Status outcome={test.outcome} />
    </li>
  );
}

/** How to link the subscription, given what the agent-runner answered about it (E8.9). */
function SubscriptionHelp({ username, state }: { username: string; state: SubscriptionState }) {
  if (state === 'linked') {
    return (
      <div class="help">
        <p>
          L&apos;abbonamento è collegato al tuo login ufficiale di Claude Code: puoi provarlo con
          &quot;Prova connessione&quot;.
        </p>
      </div>
    );
  }
  return (
    <div class="help">
      <p>
        {state === 'unknown'
          ? "Non è stato possibile verificare se l'abbonamento è collegato: l'agent-runner non ha risposto. Se non l'hai ancora fatto, si collega dal terminale del computer dove gira il CMS:"
          : "L'abbonamento non è ancora collegato. Si collega con il login ufficiale di Claude Code, dal terminale del computer dove gira il CMS:"}
      </p>
      <pre>
        <code>{connectCommand(username)}</code>
      </pre>
      <p class="hint">
        Ogni utente collega il proprio abbonamento; il CMS non vede mai la password.
      </p>
    </div>
  );
}

function KeyForm({
  api,
  action,
  connection,
  onDone,
}: {
  api: Api;
  action: Action;
  connection: ConnectionView;
  onDone: (changed: boolean) => Promise<void>;
}) {
  const [key, setKey] = useState('');
  const submit = (event: Event) => {
    event.preventDefault();
    void action
      .run(async () => {
        await api.send('PATCH', `/ai/connections/${encodeURIComponent(connection.id)}`, {
          apiKey: key,
        });
        setKey('');
        return `Chiave di "${connection.label}" aggiornata.`;
      })
      .then((ok) => onDone(ok));
  };
  return (
    <form class="form inline-form" onSubmit={submit}>
      <Field label="Nuova chiave API" hint="Dopo il salvataggio non sarà più visibile.">
        {(props) => (
          <input
            {...props}
            type="password"
            required
            autoComplete="off"
            spellcheck={false}
            value={key}
            onInput={(e) => setKey(e.currentTarget.value)}
          />
        )}
      </Field>
      <div class="actions">
        <button type="submit" class="button small" disabled={action.busy}>
          Salva la chiave
        </button>
        <button type="button" class="button secondary small" onClick={() => void onDone(false)}>
          Annulla
        </button>
      </div>
    </form>
  );
}

const TYPE_HINT: Record<ConnectionType, string> = {
  api: 'A consumo, con la chiave di un provider (Anthropic, OpenAI, OpenRouter, Mistral…).',
  subscription: 'Il tuo piano Claude Pro/Max tramite Claude Code, a prezzo fisso.',
  local: 'Un modello sul tuo computer (Ollama, LM Studio, vLLM): gratis e privato.',
};

const MODEL_PLACEHOLDER: Record<ConnectionType, string> = {
  api: 'claude-sonnet-4-5',
  subscription: 'predefinito di Claude Code',
  local: 'llama3.1:8b',
};

function AddConnection({
  api,
  action,
  username,
  onDone,
}: {
  api: Api;
  action: Action;
  username: string;
  onDone: (created: boolean) => Promise<void>;
}) {
  const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM);
  const fields = fieldsFor(form);
  const set = (key: keyof ConnectionForm) => (event: Event) =>
    setForm({ ...form, [key]: (event.currentTarget as HTMLInputElement).value });

  const submit = (event: Event) => {
    event.preventDefault();
    void action
      .run(async () => {
        await api.send('POST', '/ai/connections', connectionInput(form));
        // The key leaves the widget's memory as soon as it is stored.
        setForm(EMPTY_FORM);
        return `Connessione "${form.label.trim()}" aggiunta: provala con "Prova connessione".`;
      })
      .then(async (ok) => {
        if (ok) await onDone(true);
      });
  };

  return (
    <form class="form add-connection" onSubmit={submit}>
      <fieldset class="fieldset">
        <legend>Tipo di connessione</legend>
        <div class="radio-group">
          {(Object.keys(TYPE_LABEL) as ConnectionType[]).map((type) => (
            <label key={type} class="radio">
              <input
                type="radio"
                name="cms-connection-type"
                value={type}
                checked={form.type === type}
                onChange={() => setForm(withType(form, type))}
              />
              <span>
                <strong>{TYPE_LABEL[type]}</strong>
                <span class="hint">{TYPE_HINT[type]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Nome della connessione" hint='Per riconoscerla, es. "Anthropic dello studio".'>
        {(props) => (
          <input
            {...props}
            type="text"
            required
            maxLength={100}
            value={form.label}
            onInput={set('label')}
          />
        )}
      </Field>
      {form.type === 'api' && (
        <Field label="Provider">
          {(props) => (
            <select {...props} value={form.provider} onChange={set('provider')}>
              {providersFor('api').map((provider) => (
                <option key={provider} value={provider}>
                  {provider === 'openai-compatible'
                    ? 'Compatibile OpenAI (OpenAI, OpenRouter, Mistral, Gemini…)'
                    : PROVIDER_LABEL[provider]}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      {fields.baseUrl && (
        <Field label="Indirizzo base" hint="L'URL dell'API compatibile OpenAI, fino a /v1.">
          {(props) => (
            <input
              {...props}
              type="url"
              required
              placeholder={
                form.type === 'local'
                  ? 'http://host.docker.internal:11434/v1'
                  : 'https://api.openai.com/v1'
              }
              value={form.baseUrl}
              onInput={set('baseUrl')}
            />
          )}
        </Field>
      )}
      <Field
        label="Modello"
        hint={fields.modelRequired ? undefined : 'Facoltativo: vuoto usa il modello del piano.'}
      >
        {(props) => (
          <input
            {...props}
            type="text"
            required={fields.modelRequired}
            placeholder={MODEL_PLACEHOLDER[form.type]}
            value={form.defaultModel}
            onInput={set('defaultModel')}
          />
        )}
      </Field>
      {fields.apiKey && (
        <Field
          label={fields.apiKeyRequired ? 'Chiave API' : 'Chiave API (facoltativa)'}
          hint="Viene cifrata e non sarà più visibile, né a te né agli agenti."
        >
          {(props) => (
            <input
              {...props}
              type="password"
              required={fields.apiKeyRequired}
              autoComplete="off"
              spellcheck={false}
              value={form.apiKey}
              onInput={set('apiKey')}
            />
          )}
        </Field>
      )}
      <Field label="Uso">
        {(props) => (
          <select {...props} value={form.scope} onChange={set('scope')}>
            <option value="shared">Condivisa: la usano tutti gli utenti</option>
            <option value="personal">Personale: solo per me</option>
          </select>
        )}
      </Field>
      {form.type === 'subscription' && <SubscriptionHelp username={username} state="not_linked" />}
      <div class="actions">
        <button type="submit" class="button" disabled={action.busy}>
          Aggiungi
        </button>
        <button type="button" class="button secondary" onClick={() => void onDone(false)}>
          Annulla
        </button>
      </div>
    </form>
  );
}
