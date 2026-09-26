import { LoginForm } from '@/components/login-form.tsx';
import { safeReturnTo } from '@/lib/http.ts';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;
  return (
    <main>
      <h1>Accedi</h1>
      <p className="hint">Dopo l&apos;accesso tornerai alla pagina del sito da cui sei partito.</p>
      <LoginForm returnTo={safeReturnTo(returnTo)} />
    </main>
  );
}
