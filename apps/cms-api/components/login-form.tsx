'use client';

import { useState, type FormEvent } from 'react';
import { postJson } from './post-json.ts';

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await postJson<{ mustChangePassword: boolean }>('/api/auth/login', {
      identifier: form.get('identifier'),
      password: form.get('password'),
    });
    if (!result.ok) {
      setError(result.message);
      setPending(false);
      return;
    }
    window.location.assign(
      result.data.mustChangePassword
        ? `/_cms/password?returnTo=${encodeURIComponent(returnTo)}`
        : returnTo,
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label>
        Nome utente o email
        <input name="identifier" autoComplete="username" required autoFocus />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? 'Accesso in corso…' : 'Accedi'}
      </button>
    </form>
  );
}
