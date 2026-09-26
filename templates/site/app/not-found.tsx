import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { absolute: 'Pagina non trovata' },
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <main>
      <h1>Pagina non trovata</h1>
      <p>La pagina che cerchi non esiste o è stata spostata.</p>
      <p>
        <a href="/">Torna alla pagina iniziale</a>
      </p>
    </main>
  );
}
