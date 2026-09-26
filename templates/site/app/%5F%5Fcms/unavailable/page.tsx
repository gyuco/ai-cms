import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { absolute: 'Sito temporaneamente non disponibile' },
  robots: { index: false, follow: false },
};

/**
 * Served by the proxy with status 503 when the content database is unreachable. It reads no
 * content, so it always renders. The `/__cms/*` paths are not reachable from outside (Caddy).
 */
export default function Unavailable() {
  return (
    <main>
      <h1>Sito temporaneamente non disponibile</h1>
      <p>Non è stato possibile caricare la pagina. Riprova tra qualche istante.</p>
    </main>
  );
}
