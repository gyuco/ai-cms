'use client';

/** Last resort when even the root layout fails: a complete, valid document on its own. */
export default function GlobalError() {
  return (
    <html lang="it">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Sito temporaneamente non disponibile</title>
      </head>
      <body>
        <main>
          <h1>Sito temporaneamente non disponibile</h1>
          <p>Non è stato possibile caricare la pagina. Riprova tra qualche istante.</p>
        </main>
      </body>
    </html>
  );
}
