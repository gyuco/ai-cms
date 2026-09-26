import type { Metadata } from 'next';
import { MIN_PASSWORD_LENGTH } from '@ai-cms/auth';
import { PasswordForm } from '@/components/password-form.tsx';
import { safeReturnTo } from '@/lib/http.ts';

export const metadata: Metadata = { title: 'Cambia password · AI-CMS' };

export default async function PasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;
  return (
    <main>
      <h1>Cambia password</h1>
      <p className="hint">Scegli una nuova password prima di continuare.</p>
      <PasswordForm returnTo={safeReturnTo(returnTo)} minLength={MIN_PASSWORD_LENGTH} />
    </main>
  );
}
