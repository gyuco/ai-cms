import type { Metadata } from 'next';
import { MIN_PASSWORD_LENGTH, peekAuthToken } from '@ai-cms/auth';
import { TokenPasswordForm } from '@/components/token-password-form.tsx';
import { db } from '@/lib/db.ts';

export const metadata: Metadata = { title: 'Accetta l’invito · AI-CMS' };

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = '' } = await searchParams;
  const valid = token !== '' && (await peekAuthToken(db(), token, 'invite')) !== null;
  return (
    <main>
      <h1>Benvenuto</h1>
      {valid ? (
        <>
          <p className="hint">Scegli la password con cui accederai al sito.</p>
          <TokenPasswordForm
            token={token}
            endpoint="/api/auth/invite"
            minLength={MIN_PASSWORD_LENGTH}
            submitLabel="Attiva l’account"
          />
        </>
      ) : (
        <p className="error">Il link di invito non è valido o è scaduto. Chiedine uno nuovo.</p>
      )}
    </main>
  );
}
