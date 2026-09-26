'use client';

import { useState, type FormEvent } from 'react';
import { postJson } from './post-json.ts';

export function TokenPasswordForm({
  token,
  endpoint,
  minLength,
  submitLabel,
}: {
  token: string;
  endpoint: string;
  minLength: number;
  submitLabel: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get('password') !== form.get('confirmPassword')) {
      setError('Le due password non coincidono.');
      return;
    }
    setPending(true);
    setError(null);
    const result = await postJson(endpoint, { token, password: form.get('password') });
    if (!result.ok) {
      setError(result.message);
      setPending(false);
      return;
    }
    window.location.assign('/');
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label>
        Nuova password (almeno {minLength} caratteri)
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          required
          autoFocus
        />
      </label>
      <label>
        Ripeti la password
        <input name="confirmPassword" type="password" autoComplete="new-password" required />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? 'Salvataggio…' : submitLabel}
      </button>
    </form>
  );
}
