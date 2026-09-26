import { useState } from 'preact/hooks';
import { userStatusLabel } from '../format.ts';
import { useWidget } from '../widget-context.ts';
import { ConfirmButton, Field, LoadState, Section, Status, useAction, useLoad } from './common.tsx';

interface UserSummary {
  uid: number;
  username: string;
  displayName: string | null;
  email: string;
  status: string;
}

const ROOT_UID = 0;

/** Users tab (E7.9): list, invitation, suspension and reactivation. */
export function UsersTab() {
  const { api, context } = useWidget();
  const loaded = useLoad(() => api.get<{ users: UserSummary[] }>('/users'), [api]);
  const action = useAction();
  const self = context.user.uid;

  const setStatus = (user: UserSummary, verb: 'suspend' | 'reactivate') =>
    void action.run(async () => {
      await api.send('POST', `/users/${String(user.uid)}/${verb}`);
      await loaded.reload();
      return verb === 'suspend'
        ? `${user.username} è sospeso: le sue sessioni sono state chiuse.`
        : `${user.username} è di nuovo attivo.`;
    });

  return (
    <div class="stack">
      <Status outcome={action.outcome} />
      <Section title="Utenti">
        <p class="hint">
          In questa fase ogni utente è amministratore. Gruppi e permessi arriveranno in seguito.
        </p>
        <LoadState loaded={loaded}>
          {({ users }) => (
            <ul class="user-list">
              {users.map((user) => {
                const state = userStatusLabel(user.status);
                const locked = user.uid === self || user.uid === ROOT_UID;
                return (
                  <li key={user.uid} class="user-item">
                    <span class="user-info">
                      <span>
                        <strong>{user.displayName || user.username}</strong>
                        {user.uid === self && <span class="muted"> (tu)</span>}
                      </span>
                      <span class="user-detail">
                        {user.username} · {user.email}
                      </span>
                    </span>
                    <span class={`badge tone-${state.tone}`}>{state.label}</span>
                    {user.status === 'suspended' ? (
                      <button
                        type="button"
                        class="button secondary small"
                        disabled={action.busy}
                        aria-label={`Riattiva ${user.username}`}
                        onClick={() => setStatus(user, 'reactivate')}
                      >
                        Riattiva
                      </button>
                    ) : locked ? (
                      <span class="user-lock muted">
                        <span aria-hidden="true">—</span>
                        <span class="visually-hidden">
                          {user.uid === self
                            ? 'Non puoi sospendere te stesso.'
                            : "L'utente root non si può sospendere."}
                        </span>
                      </span>
                    ) : (
                      <ConfirmButton
                        small
                        label="Sospendi"
                        ariaLabel={`Sospendi ${user.username}`}
                        question={`Sospendere ${user.username}? Verrà disconnesso subito.`}
                        confirmLabel="Sospendi"
                        disabled={action.busy}
                        onConfirm={() => setStatus(user, 'suspend')}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </LoadState>
      </Section>
      <InviteSection onInvited={loaded.reload} />
    </div>
  );
}

function InviteSection({ onInvited }: { onInvited: () => Promise<void> }) {
  const { api } = useWidget();
  const action = useAction();
  const empty = { username: '', email: '', displayName: '' };
  const [form, setForm] = useState(empty);
  const set = (key: keyof typeof empty) => (event: Event) =>
    setForm({ ...form, [key]: (event.currentTarget as HTMLInputElement).value });

  const invite = (event: Event) => {
    event.preventDefault();
    void action.run(async () => {
      await api.send('POST', '/users/invite', form);
      setForm(empty);
      await onInvited();
      return `Invito inviato a ${form.email}: il link vale 7 giorni.`;
    });
  };

  return (
    <Section title="Invita un utente">
      <form class="form" onSubmit={invite}>
        <div class="form-row">
          <Field label="Nome utente">
            {(props) => (
              <input
                {...props}
                type="text"
                required
                autoComplete="off"
                value={form.username}
                onInput={set('username')}
              />
            )}
          </Field>
          <Field label="Nome e cognome" hint="Facoltativo.">
            {(props) => (
              <input
                {...props}
                type="text"
                autoComplete="off"
                value={form.displayName}
                onInput={set('displayName')}
              />
            )}
          </Field>
        </div>
        <Field label="Email" hint="Riceverà il link per scegliere la password.">
          {(props) => (
            <input
              {...props}
              type="email"
              required
              autoComplete="off"
              value={form.email}
              onInput={set('email')}
            />
          )}
        </Field>
        <div class="actions">
          <button type="submit" class="button" disabled={action.busy}>
            Invia l'invito
          </button>
        </div>
        <Status outcome={action.outcome} />
      </form>
    </Section>
  );
}
