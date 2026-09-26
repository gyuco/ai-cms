'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { postJson } from './post-json.ts';

export function PasswordForm({ returnTo, minLength }: { returnTo: string; minLength: number }) {
  const [csrfToken, setCsrfToken] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetch('/_cms/api/auth/me')
      .then((response) => {
        if (response.status === 401) {
          window.location.assign(`/_cms/login?returnTo=${encodeURIComponent(returnTo)}`);
          return null;
        }
        return response.json();
      })
      .then((data) => data && setCsrfToken(data.csrfToken))
      .catch(() => setError('Impossibile contattare il server. Riprova.'));
  }, [returnTo]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get('newPassword') !== form.get('confirmPassword')) {
      setError('Le due password non coincidono.');
      return;
    }
    setPending(true);
    setError(null);
    const result = await postJson(
      '/api/auth/password',
      { currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') },
      csrfToken,
    );
    if (!result.ok) {
      setError(result.message);
      setPending(false);
      return;
    }
    window.location.assign(returnTo);
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label>
        Password attuale
        <input name="currentPassword" type="password" autoComplete="current-password" required />
      </label>
      <label>
        Nuova password (almeno {minLength} caratteri)
        <input
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          required
        />
      </label>
      <label>
        Ripeti la nuova password
        <input name="confirmPassword" type="password" autoComplete="new-password" required />
      </label>
      <button type="submit" disabled={pending || !csrfToken}>
        {pending ? 'Salvataggio…' : 'Cambia password'}
      </button>
    </form>
  );
}
