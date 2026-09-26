import type { Metadata } from 'next';
import { MIN_PASSWORD_LENGTH, peekAuthToken } from '@ai-cms/auth';
import { ResetRequestForm } from '@/components/reset-request-form.tsx';
import { TokenPasswordForm } from '@/components/token-password-form.tsx';
import { db } from '@/lib/db.ts';

export const metadata: Metadata = { title: 'Reimposta la password · AI-CMS' };

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <main>
        <h1>Password dimenticata</h1>
        <p className="hint">Indica l&apos;email del tuo account: ti invieremo un link.</p>
        <ResetRequestForm />
      </main>
    );
  }

  const valid = (await peekAuthToken(db(), token, 'reset')) !== null;
  return (
    <main>
      <h1>Nuova password</h1>
      {valid ? (
        <TokenPasswordForm
          token={token}
          endpoint="/api/auth/reset/confirm"
          minLength={MIN_PASSWORD_LENGTH}
          submitLabel="Salva la password"
        />
      ) : (
        <p className="error">
          Il link non è valido o è scaduto. <a href="/_cms/reset">Richiedine uno nuovo</a>.
        </p>
      )}
    </main>
  );
}
