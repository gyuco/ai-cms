# Guida al primo avvio

Questa guida porta da un ambiente vuoto al primo sito pubblicato parlando con l'AI
(PRD §6.2). Ogni comando e ogni nome di pulsante è quello del codice attuale; dove una
funzione non è ancora completa, lo trovi in [Limiti noti](#limiti-noti).

## 1. Avviare il sistema

Servono Node.js 22, pnpm 10 e Docker con Docker Compose (vedi il [README](../README.md)).

```bash
make up      # genera i segreti in docker/secrets/, costruisce le immagini e avvia i servizi
make ps      # stato dei servizi
make help    # tutti i comandi
```

Al primo avvio `cms-api` applica le migrazioni ed esegue il seed: crea l'utente `root`,
l'albero base, la home `/site/pages/index` vuota e le impostazioni del sito ("Nuovo sito",
lingua `it`). Rieseguire il seed non duplica nulla (`make seed` riavvia `cms-api`).

| Indirizzo                            | Servizio                           |
| ------------------------------------ | ---------------------------------- |
| http://www.localhost                 | Sito di produzione (pagina bianca) |
| http://staging.localhost             | Sito di staging                    |
| http://www.localhost/\_cms/api/health | Backend del CMS                    |
| http://mail.localhost                | Mailpit (email di sviluppo)        |

## 2. Password di root

La password di `root` è casuale e viene stampata **una sola volta** nei log di `cms-api`:

```bash
make root-password
```

Se non la trovi più (è mostrata solo al primo avvio):

```bash
make reset-root-password   # genera una nuova password temporanea per root
```

## 3. Primo accesso

1. Apri http://www.localhost/\_cms/login e accedi con utente `root` e la password del passo 2.
2. Il sistema chiede di **cambiare la password** al primo accesso.
3. Tornerai sulla home, ora con il **widget** del CMS: il pulsante flottante è visibile
   solo a chi ha effettuato l'accesso. Il widget ha sette schede: **Chat**, **Pagina**,
   **Sito**, **Sviluppo**, **Utenti**, **AI**, **Audit**. Il cambio tra **Produzione** e
   **Staging** è nel widget.

Per invitare altre persone usa la scheda **Utenti**: l'invito arriva per email (in locale la
trovi in Mailpit, http://mail.localhost).

## 4. Collegare l'AI

Apri la scheda **AI** e aggiungi una connessione. Ci sono tre tipi:

| Tipo                    | Cosa serve                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------- |
| **Chiave API**          | La chiave di un provider: Anthropic oppure un servizio compatibile OpenAI (OpenAI, OpenRouter, Mistral, Gemini…). Per i servizi compatibili OpenAI indica anche l'indirizzo base fino a `/v1`. |
| **Modello locale**      | Un modello sul tuo computer (Ollama, LM Studio, vLLM), ad esempio `http://host.docker.internal:11434/v1`. |
| **Abbonamento**         | Il tuo abbonamento Claude Code (Pro, Max, Team), vedi sotto.                            |

Dopo averla aggiunta:

1. Premi **Prova connessione** per verificarla.
2. Premi **Usa per tutti i ruoli** per renderla la connessione attiva (compare il badge
   "Attiva per tutti i ruoli").

Le chiavi API sono cifrate e, dopo il salvataggio, non sono più visibili.

### Abbonamento Claude Code

Ognuno collega il **proprio** account, dal terminale del computer dove gira il CMS:

```bash
make connect-claude-code user=<username>
```

Si apre il login ufficiale di Claude Code; le credenziali restano nel container
`agent-runner` e il CMS non vede mai la password. Nella scheda **AI** lo stato appare come
"Abbonamento collegato" o "Abbonamento non collegato". I servizi escono su internet solo
tramite `egress-proxy`, che consente gli host elencati in `EGRESS_ALLOW`: i valori di
esempio in `docker/.env.example` includono già `.anthropic.com`, `.claude.ai` e
`.claude.com`.

> **Limite:** al momento la **Chat non funziona con una connessione in abbonamento**: se
> l'agente è collegato a un abbonamento risponde di scegliere una connessione con chiave
> API. Per costruire il sito dal passo 5 usa una connessione a chiave API o un modello
> locale.

## 5. Creare il primo sito con la chat

Nella scheda **Chat** scrivi, ad esempio:

> Crea un sito per il mio studio di architettura: home con presentazione, pagine Progetti,
> Chi siamo e Contatti, con header e menu.

L'agente contenuti propone struttura, layout condiviso (header, footer, menu) e contenuti.
Le modifiche di un turno si accumulano in un **piano**:

- sulla pagina che stai guardando, se il piano la tocca, compare l'**anteprima** al posto
  di `<main>`, con i blocchi aggiunti in verde e quelli modificati in giallo
  (interruttore "Mostra l'anteprima sulla pagina");
- **Conferma** esegue il piano in un'unica transazione, **Annulla** lo scarta e ripristina
  la pagina;
- le operazioni distruttive (eliminazioni, ritiro di pagine, riscritture ampie) richiedono
  una conferma esplicita;
- dopo la conferma, **Ricarica la pagina** per vedere il risultato.

Le versioni pubblicate salvano la conversazione da cui provengono, e la Chat mostra lo
storico delle conversazioni della pagina. La scheda **Pagina** mostra versioni e stato di
pubblicazione, la scheda **Sito** le impostazioni condivise.

L'agente rispetta sempre i vincoli di sistema (ad esempio non tocca codice, segreti o audit):
sono applicati da `authz`, non dal prompt, e valgono anche per `root`.

## 6. Staging e agente sviluppatore

Le funzioni dinamiche (codice, API, migrazioni) si sviluppano in **staging**, in un
*changeset* con il proprio ramo git, il proprio database e la propria anteprima
`cs-<id>.localhost`. L'agente sviluppatore lavora solo in staging, dentro un workspace
isolato, con un elenco chiuso di comandi; `pnpm add` è consentito solo per i pacchetti che
l'utente ha approvato in chat.

Per lavorarci dal widget, in staging apri la scheda **Chat** e passa da *Contenuti* a
*Sviluppo*: scrivi il titolo di una nuova modifica e premi **Crea** (il worker prepara il
changeset in pochi secondi), oppure scegli una modifica aperta dall'elenco. Poi descrivi cosa
costruire; l'agente scrive il codice nella copia del sito e a fine turno salva un commit. Se
gli serve un pacchetto npm, apri **Approva nuovi pacchetti**, scrivi il nome (senza versione né
indirizzi) e premi **Approva**: da quel momento potrà aggiungerlo. Controlli, approvazione e
pubblicazione restano nella scheda **Sviluppo**.

I controlli automatici (build, test, regole di sicurezza, migrazioni distruttive) girano nel
worker. Se falliscono, gli errori tornano all'agente per **al massimo 3 tentativi** di
correzione automatica; lo stato è visibile nella scheda **Sviluppo**.

## 7. Approvare, pubblicare, tornare indietro

Nella scheda **Sviluppo**:

- **Modifiche in corso**: stato di ogni changeset, controlli con log, riga sulla correzione
  automatica e link all'anteprima.
- **Approva e pubblica**, per i changeset pronti. Se contengono migrazioni distruttive viene
  mostrato un avviso da confermare.
- **Rifiuta**, con un commento obbligatorio: torna all'agente come richiesta di modifiche.
- **Release**: storico con stato, approvatore e modifiche incluse.
- **Rollback**, disponibile solo per l'ultima release pubblicata, se ne esiste una
  precedente.

Il job di release prende un lock globale, fa il rebase su `main` (rieseguendo i controlli se
`main` è cambiato), costruisce l'artefatto, fa il `pg_dump` delle tabelle interessate, applica
le migrazioni in una transazione, sposta il puntatore `current`, riavvia `site-prod` e fa un
health check; se fallisce ripristina l'artefatto precedente. Il rollback riporta `current`
all'artefatto della release precedente e **non ripristina il database**: per questo le
migrazioni devono prima aggiungere e solo dopo togliere.

## Limiti noti

Questi limiti valgono per lo stato attuale del codice:

- **Chat con abbonamento**: non ancora disponibile (vedi passo 4).
- **Piani in attesa**: sono tenuti in memoria di `cms-api` e scadono dopo 30 minuti; un
  riavvio li perde e l'agente li riproporrà.
- **Chat con l'agente sviluppatore**: il ruolo `dev-agent` deve avere una connessione con
  chiave API (o un abbonamento collegato, vedi passo 4) nella scheda AI. Una modifica accetta
  messaggi finché è in lavorazione o con controlli falliti; dopo "pronta" l'agente non la
  cambia più (un rifiuto con commento la riapre).
- **Pacchetti approvati**: l'approvazione vale per la conversazione, non per il singolo
  comando; non si può ritirare dal widget.
- **Rollback e git**: non tocca `main`, il tag `release-<n>` né `staging`; la release
  successiva riparte da un `main` che contiene ancora le modifiche annullate.
- **Anteprima dei blocchi tolti**: compaiono solo per tipo nel pannello del piano, non sulla
  pagina; l'anteprima riguarda solo la pagina che si sta guardando.
- **Link alle anteprime**: usano sempre `http://`; con HTTPS in produzione vanno adattati.
- **Release e rollback in Docker**: sono verificati dai test e da controlli statici, non
  ancora con un flusso completo sull'ambiente Docker.
- **Permessi**: in questa fase tutti gli utenti sono amministratori; i gruppi e i permessi
  in stile Linux arrivano nella fase 2.
