'use client';

/**
 * Shown when a page cannot be rendered, typically because the content database is not
 * reachable. The message is generic: details stay in the server log.
 */
export default function ErrorPage() {
  return (
    <main>
      <title>Sito temporaneamente non disponibile</title>
      <h1>Sito temporaneamente non disponibile</h1>
      <p>Non è stato possibile caricare la pagina. Riprova tra qualche istante.</p>
    </main>
  );
}
