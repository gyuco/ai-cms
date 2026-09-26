'use client';

import { useState, type FormEvent } from 'react';
import { postJson } from './post-json.ts';

export function ResetRequestForm() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await postJson('/api/auth/reset/request', { email: form.get('email') });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <p role="status">
        Se l&apos;indirizzo corrisponde a un account attivo, riceverai un&apos;email con il link per
        reimpostare la password.
      </p>
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
        Email
        <input name="email" type="email" autoComplete="email" required autoFocus />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? 'Invio…' : 'Invia il link'}
      </button>
    </form>
  );
}
