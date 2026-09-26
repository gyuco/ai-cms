# MVP 1 — Task e subtask

> Piano di lavoro per la prima versione funzionante di AI-CMS.
> Requisiti: `PRD.md` · Architettura: `TECHNICAL.md`.

## Obiettivo

Alla fine dell'MVP 1, in locale con `docker compose up`, si può:

1. partire da una **pagina bianca** e costruire un sito **solo dal widget in pagina**;
2. gestire utenti, gruppi e permessi con il **modello Linux** completo;
3. modificare i contenuti in **produzione** con l'agente contenuti;
4. sviluppare pagine dinamiche e collezioni in **staging** con l'agente sviluppatore;
5. portarle in produzione con **un clic** e fare **rollback**;
6. usare un **abbonamento** (Claude Code) oppure una **chiave API** (Anthropic o compatibile OpenAI).

Criteri di accettazione: tutti quelli di PRD §9 (1–12).

## Cosa resta fuori dall'MVP 1

Rinviato all'MVP 2 per mantenere l'MVP 1 semplice:

| Area | Rinviato |
|---|---|
| Autenticazione | TOTP, token API, account di servizio |
| Permessi | "Chi può?", "Cosa può?", simulazione, scadenza di permessi e appartenenze |
| Contenuti | Pubblicazione programmata, link di anteprima condivisibili, multilingua, interfaccia del cestino |
| AI | Adattatori nativi OpenAI e Google, Codex CLI e Gemini CLI, riserve, limiti di spesa, cruscotto consumi, revisione AI |
| Release | Zero downtime (blue/green), più changeset per release, separazione dei compiti |
| Staging | Copia dei dati applicativi di produzione (nell'MVP 1 si copiano solo contenuti e asset) |
| Audit | Job di verifica periodica della catena di hash, esportazione |

## Convenzioni

- **ID:** `E<epic>.<task>`, ad esempio `E4.2`. I subtask sono le caselle.
- **Dimensione:** **S** fino a 1 giorno · **M** 2–3 giorni · **L** 4–5 giorni.
- **Dipende da:** i task che devono essere completati prima.
- **Fatto quando:** il criterio che chiude il task. Ogni task include i propri test.

---

## Ordine di lavoro

```
Fase A — Fondamenta     E0 → E1 → E2 → E3
Fase B — Permessi       E4 → E5
Fase C — Sito e widget  E6 → E7.1–E7.3, E7.6–E7.9, E7.12
Fase D — AI             E8 → E9 → E7.4, E7.5, E7.10    ← primo sito costruibile via chat
Fase E — Staging        E10 → E11
Fase F — Release        E12 → E7.11 → E13              ← MVP 1 completo
```

Milestone intermedie:

| Milestone | Fine della fase | Risultato visibile |
|---|---|---|
| **A** | Fase A | `docker compose up`, pagina bianca, login funzionante |
| **B** | Fase B | Permessi completi e testati, contenuti gestibili da API |
| **C** | Fase C | Widget su ogni pagina, contenuti, utenti e permessi gestibili dalle schede |
| **D** | Fase D | Sito costruito da zero parlando in chat, in produzione |
| **E** | Fase E | Pagina dinamica sviluppata in staging, controlli verdi |
| **F** | Fase F | Approva e pubblica, rollback, suite di accettazione verde |

---

## E0 — Repository e strumenti

### E0.1 Monorepo — **M**
- [ ] pnpm workspaces + Turborepo
- [ ] TypeScript strict con `tsconfig` base condiviso
- [ ] ESLint + Prettier con configurazione condivisa
- [ ] Vitest configurato a livello di monorepo
- [ ] Scheletro vuoto di app e pacchetti: `apps/cms-api`, `apps/worker`, `packages/{authz,db,tree,content,audit,auth,ai,mcp-tools,agents,pipeline,site-kit,widget,html-rules}`, `templates/site`
- [ ] Script radice: `dev`, `build`, `test`, `lint`, `typecheck`

**Fatto quando:** `pnpm install && pnpm build && pnpm test` passa su un clone pulito.

### E0.2 CI — **S** · dipende da E0.1
- [ ] GitHub Actions: install con cache, lint, typecheck, test
- [ ] Job con Postgres di servizio per i test di integrazione

**Fatto quando:** una PR mostra i controlli verdi.

### E0.3 Guida per chi sviluppa — **S** · dipende da E0.1
- [ ] `README.md`: requisiti, avvio, struttura
- [ ] `CLAUDE.md`: convenzioni del progetto per gli agenti di sviluppo

---

## E1 — Ambiente Docker locale

### E1.1 Servizi di base — **M** · dipende da E0.1
- [ ] `docker/compose.yml` con `postgres-core`, `postgres-prod`, `postgres-staging`, `minio`, `mailpit`, `caddy`
- [ ] Reti `control`, `prod`, `staging`, `egress`
- [ ] Volumi: `pg-core`, `pg-prod`, `pg-staging`, `git-repos`, `workspaces`, `releases`, `backups`, `minio-data`, `cli-auth`
- [ ] Healthcheck per ogni servizio
- [ ] `.env.example`
- [ ] Postgres: estensioni `ltree` e `citext`, database e ruoli separati per servizio

**Fatto quando:** `docker compose up` avvia i servizi e tutti risultano healthy.

### E1.2 Immagini applicative — **M** · dipende da E1.1
- [ ] Dockerfile `cms-api` (multi-stage, utente non root)
- [ ] Dockerfile `worker`
- [ ] Dockerfile `agent-runner` con Claude Code CLI a **versione fissata**, git, pnpm
- [ ] Dockerfile `site-runtime` (filesystem in sola lettura, non root)
- [ ] Dockerfile `builder` per build e test usa e getta

### E1.3 Routing con Caddy — **S** · dipende da E1.2
- [ ] `www.localhost` → `site-prod`
- [ ] `staging.localhost` → `site-staging`
- [ ] `/_cms/*` su ogni host del sito → `cms-api`
- [ ] `cs-<id>.localhost` → `previews` (route dinamiche via API admin di Caddy)
- [ ] `mail.localhost`, `minio.localhost`

### E1.4 Segreti e uscita di rete — **S** · dipende da E1.1
- [ ] Docker secrets per servizio, secondo la tabella in TECHNICAL §13
- [ ] `egress-proxy` con allowlist (endpoint dei provider AI, registry npm)
- [ ] `agent-runner`, `site-prod` e `builder` escono solo tramite il proxy

### E1.5 Script di gestione — **S** · dipende da E1.2
- [ ] `make up | down | reset | logs | seed | shell-<servizio>`
- [ ] `reset` distrugge i volumi solo dopo una conferma

---

## E2 — Database della piattaforma

### E2.1 Drizzle e migrazioni — **S** · dipende da E0.1, E1.1
- [ ] `packages/db`: client, configurazione drizzle-kit, runner delle migrazioni all'avvio di `cms-api`

### E2.2 Schema identità — **S** · dipende da E2.1
- [ ] `groups`, `users`, `group_members`, `capability_grants`, `sessions`

### E2.3 Schema albero e permessi — **M** · dipende da E2.1
- [ ] `nodes` con `ltree`, indice GiST, `UNIQUE (parent_id, name)`
- [ ] `acl_entries`
- [ ] Vincoli e check su `kind`, `storage`, `env`, `attrs`

### E2.4 Schema contenuti — **S** · dipende da E2.3
- [ ] `content_versions`, `publications`
- [ ] Vista `published_content` e ruolo `site_content_ro`

### E2.5 Schema sviluppo e release — **S** · dipende da E2.1
- [ ] `changesets`, `check_runs`, `reviews`, `releases`

### E2.6 Schema AI e conversazioni — **S** · dipende da E2.1
- [ ] `conversations`, `messages` (collegati ai nodi e alle versioni, FR-08)
- [ ] `ai_usage` in versione minima (registrazione, senza cruscotto)

### E2.7 Audit — **M** · dipende da E2.1
- [ ] Tabella `audit_log` con `prev_hash` e `hash`
- [ ] Trigger che impedisce `UPDATE` e `DELETE`
- [ ] Ruolo `audit_writer` con solo `INSERT`
- [ ] `packages/audit`: `write(event)` con calcolo dell'hash, serializzato per evitare biforcazioni della catena

**Fatto quando:** un test verifica che `UPDATE` e `DELETE` falliscono e che la catena è coerente.

### E2.8 Seed iniziale — **M** · dipende da E2.2–E2.7
- [ ] Utenti `root` (uid 0) e `system`
- [ ] Gruppi predefiniti (PRD §5.7.8) e relative capability
- [ ] Albero base (`/site/{pages,layouts,components,menus,assets}`, `/data/collections`, `/code/{api,lib,migrations}`, `/releases`, `/system/...`) con i permessi di partenza
- [ ] Home `/site/pages/index` **vuota** e impostazioni del sito (nome "Nuovo sito", lingua `it`)
- [ ] Password di root casuale, stampata una sola volta nei log
- [ ] Idempotente: rieseguirlo non duplica nulla

---

## E3 — Autenticazione

### E3.1 Password e sessioni — **M** · dipende da E2.2
- [ ] `packages/auth`: hash `argon2id`, verifica, parametri OWASP
- [ ] Sessioni server-side, cookie `cms_session` (`HttpOnly`, `Secure`, `SameSite=Lax`)
- [ ] Rotazione dell'id di sessione al login e al cambio di privilegi
- [ ] Cookie di segnale `cms_ui=1` (senza valore di sicurezza)
- [ ] Logout
- [ ] Blocco progressivo dopo tentativi falliti

### E3.2 Pagina di login — **S** · dipende da E3.1
- [ ] `/_cms/login`: form minimale e accessibile, ritorno alla pagina di partenza
- [ ] Cambio password obbligatorio al primo accesso di root

### E3.3 CSRF e contesto richiesta — **S** · dipende da E3.1
- [ ] Token CSRF per le chiamate che modificano dati
- [ ] Middleware che costruisce il `RequestContext` con il `Principal`

### E3.4 Inviti e recupero password — **M** · dipende da E3.1, E1.1
- [ ] Invito via email (Mailpit in locale), link monouso con scadenza
- [ ] Impostazione della password dall'invito
- [ ] Recupero password

### E3.5 Accesso unico tra produzione e staging — **S** · dipende da E3.1, E1.3
- [ ] `cms-api` genera un token monouso
- [ ] `/_cms/sso?t=…` imposta la sessione sull'altro host

---

## E4 — Motore dei permessi

### E4.1 Codifica dei permessi — **S** · dipende da E0.1
- [ ] Bitmask degli 8 permessi `r l x w c d p m` e degli attributi
- [ ] Parser e formatter simbolici (`u=rlxwcd g=rlx o=rlx`, `g+p`, `o-w`)
- [ ] Compatibilità ottale classica (`755` → permessi estesi)

### E4.2 Funzione `check` — **L** · dipende da E4.1
- [ ] Passo 1: vincoli di sistema I1–I7
- [ ] Passo 2: intersezione con profilo agente, maschera del token, scope della conversazione
- [ ] Passo 3: root
- [ ] Passo 4: attraversamento (`x` su tutti gli antenati)
- [ ] Passo 5: regole di negazione
- [ ] Passo 6: scelta della classe (owner → utente nominato → gruppi → other), maschera
- [ ] Attributi: sticky, immutable, append-only
- [ ] ACL limitate per ambiente

### E4.3 Spiegazione delle decisioni — **S** · dipende da E4.2
- [ ] `Decision.steps` passo per passo
- [ ] Formattazione leggibile in italiano per la chat e il widget ("Perché?", FR-88)

### E4.4 Capability — **S** · dipende da E4.1
- [ ] `requireCap(principal, cap)`
- [ ] Caricamento delle capability da utente e gruppi

### E4.5 Ereditarietà alla creazione — **M** · dipende da E4.2
- [ ] Proprietario, gruppo (con setgid), mode di default per tipo di nodo, umask
- [ ] Copia delle ACL di default; propagazione di setgid alle sottocartelle

### E4.6 Adattatore DB e cache — **M** · dipende da E4.2, E2.3
- [ ] Caricamento di nodo, antenati e ACL in una sola query
- [ ] Memorizzazione per richiesta
- [ ] Cache LRU con invalidazione tramite `LISTEN/NOTIFY`

### E4.7 Test del motore — **L** · dipende da E4.2–E4.5
- [ ] Test tabellari sulla semantica POSIX (owner con meno permessi di other, maschera, utente nominato, negazione)
- [ ] Property test con fast-check: root soggetto ai vincoli, `x` mancante nega sempre, deny vince sempre, agente ⊆ utente
- [ ] Test degli attributi e dell'ereditarietà

**Fatto quando:** copertura ≥ 95% su `packages/authz`.

### E4.8 Punto unico di accesso al DB — **S** · dipende da E0.1
- [ ] Regola ESLint: `packages/db` importabile solo da `tree`, `content`, `pipeline`, `auth`, `audit`

---

## E5 — Albero e contenuti

### E5.1 Servizio albero — **L** · dipende da E4.6, E2.7
- [ ] Creare, leggere, elencare, rinominare, spostare, eliminare (soft delete) nodi
- [ ] `chmod`, `chown` (con `CAP_CHOWN`), `chgrp`, `setfacl`, `getfacl`, attributi (con `CAP_ATTR`)
- [ ] Concorrenza ottimistica con `version`
- [ ] Ogni metodo chiama `authz.require` e scrive nell'audit

### E5.2 Modello a blocchi — **M** · dipende da E0.1
- [ ] Schemi Zod: `heading` (livello 1–6), `paragraph`, `richtext`, `image`, `gallery`, `list`, `quote`, `button`/`link`, `section` (contenitore), `html`
- [ ] Schema `meta` della pagina: title, description, lang, canonical, robots, Open Graph

### E5.3 Versioni e pubblicazione — **M** · dipende da E5.1, E5.2, E2.4
- [ ] Salvataggio come nuova versione
- [ ] Pubblica e ritira (permesso `p`), ripristino di una versione precedente
- [ ] Confronto tra due versioni

### E5.4 Sanitizzazione HTML — **S** · dipende da E5.2
- [ ] `sanitize-html` con allowlist; mai `<script>` né attributi `on*` (FR-112)

### E5.5 Asset — **M** · dipende da E5.1, E1.1
- [ ] Upload su MinIO, un bucket per ambiente
- [ ] Ridimensionamento delle immagini con `sharp`, formati moderni
- [ ] Testo alternativo obbligatorio o marcatura come decorativa

### E5.6 Elementi condivisi del sito — **S** · dipende da E5.3
- [ ] Nodi per layout (header, footer), menu, impostazioni del sito (nome, modello del titolo, lingua, favicon)

### E5.7 Piani transazionali — **M** · dipende da E5.1, E5.3
- [ ] Un piano = lista di operazioni su più nodi
- [ ] Validazione completa (permessi e regole HTML) prima dell'esecuzione
- [ ] Esecuzione in una sola transazione (FR-63)

---

## E6 — Sito e regole HTML

### E6.1 Template del sito — **M** · dipende da E0.1
- [ ] `templates/site`: Next.js App Router, dipendenza da `site-kit`
- [ ] Layout radice minimo, HTML5 valido e vuoto (TECHNICAL §10.5)
- [ ] Loader inline del widget legato al cookie `cms_ui`
- [ ] `cms.manifest.json` iniziale

### E6.2 Renderer dei blocchi — **M** · dipende da E5.2, E6.1
- [ ] `site-kit`: blocchi → HTML semantico
- [ ] Attributi `data-cms-node` e `data-cms-block`
- [ ] Calcolo della struttura dei titoli (outline)

### E6.3 Rotta catch-all e bozze — **M** · dipende da E6.2, E2.4
- [ ] Lettura da `published_content` con ruolo in sola lettura
- [ ] Next.js Draft Mode per gli utenti con `r` sulle bozze (FR-150)
- [ ] 404 conforme alle regole HTML

### E6.4 Head, sitemap e robots — **S** · dipende da E6.3, E5.6
- [ ] `generateMetadata` dai metadati di pagina e dai default del sito
- [ ] `app/sitemap.ts` e `app/robots.ts` generati dall'albero

### E6.5 Revalidazione — **S** · dipende da E6.3
- [ ] `POST /__cms/revalidate` con token, solo rete interna
- [ ] Chiamata dal servizio contenuti alla pubblicazione

### E6.6 Regole HTML — **L** · dipende da E6.2
- [ ] `packages/html-rules`: configurazione di `html-validate`
- [ ] Regole proprie: un solo `h1`, un solo `main`, titolo unico nel sito, landmark, lunghezza di title e description
- [ ] Livelli errore/avviso come in TECHNICAL §11.1
- [ ] Output strutturato, leggibile da agente e widget

### E6.7 Regole nella pubblicazione — **S** · dipende da E6.6, E5.3
- [ ] Render della bozza → validazione → blocco della pubblicazione con errori gravi (FR-168)

### E6.8 Header di sicurezza — **S** · dipende da E6.1
- [ ] CSP con nonce, `X-Content-Type-Options`, `Referrer-Policy`

---

## E7 — Widget

### E7.1 Scheletro del widget — **M** · dipende da E0.1
- [ ] `packages/widget`: Preact + Vite, custom element `<cms-widget>` con Shadow DOM
- [ ] Bundle unico servito da `cms-api` su `/_cms/widget.js`

### E7.2 API di contesto — **S** · dipende da E3.3, E4.6
- [ ] `GET /_cms/api/context?path=…`: nodo, permessi effettivi, capability, ambiente, token CSRF

### E7.3 Shell — **M** · dipende da E7.1, E7.2
- [ ] Pannello flottante: apri/chiudi, sposta, ridimensiona, stato salvato in `localStorage`
- [ ] Scorciatoia `Ctrl/Cmd + .`, gestione del focus, WCAG 2.1 AA
- [ ] Indicatore di ambiente e passaggio produzione ↔ staging (E3.5)
- [ ] Schede visibili in base ai permessi

### E7.4 Scheda Chat — **L** · dipende da E7.3, E9.3
- [ ] Streaming SSE da `POST /_cms/api/chat`
- [ ] Messaggi, stato dell'agente, azioni in corso, errori e permessi negati spiegati
- [ ] Piano proposto con **Conferma** / **Annulla**
- [ ] Storico delle conversazioni della pagina

### E7.5 Anteprima sul posto — **M** · dipende da E7.4, E6.3
- [ ] Rendering in bozza del piano, sostituzione temporanea di `<main>`
- [ ] Evidenziazione delle differenze; ripristino con Annulla

### E7.6 Selezione di elementi — **S** · dipende da E7.3, E6.2
- [ ] Modalità "seleziona": overlay, clic, riferimento inviato alla chat

### E7.7 Scheda Pagina — **M** · dipende da E7.3, E5.3, E6.6
- [ ] Metadati (title, description, social) modificabili
- [ ] Stato, versioni, ripristino, pubblica/ritira
- [ ] Esito delle regole HTML
- [ ] Proprietario, gruppo, permessi e ACL del nodo; pulsante "Perché?"

### E7.8 Scheda Sito — **M** · dipende da E7.3, E5.1
- [ ] Albero delle pagine con navigazione e creazione
- [ ] Menu, layout, impostazioni del sito

### E7.9 Scheda Utenti e permessi — **M** · dipende da E7.3, E3.4, E5.1
- [ ] Utenti: elenco, invito, sospensione, gruppi
- [ ] Gruppi: creazione, membri
- [ ] Vista stile `ls -l` / `getfacl` e modifica di mode e ACL, con anteprima dell'effetto

### E7.10 Scheda AI — **S** · dipende da E7.3, E8.6
- [ ] Inserimento della chiave API (mai più visualizzabile)
- [ ] Stato dell'abbonamento collegato e istruzioni per `cms-connect`
- [ ] Pulsante "Prova connessione"

### E7.11 Scheda Sviluppo — **M** · dipende da E7.3, E11.4, E12.1
- [ ] Changeset aperti, stato dei controlli con log, link all'anteprima
- [ ] **Approva e pubblica** (con avviso sulle migrazioni distruttive), **Rifiuta** con commento
- [ ] Storico delle release e **Rollback**

### E7.12 Scheda Audit — **S** · dipende da E7.3, E2.7
- [ ] Elenco filtrabile per utente, nodo, azione, periodo, esito

---

## E8 — Livello AI

### E8.1 Interfacce comuni — **M** · dipende da E0.1
- [ ] `ChatEngine`, `ChatRequest`, `ChatEvent`, formato dei messaggi normalizzato
- [ ] Conversione degli strumenti Zod → JSON Schema

### E8.2 Adattatore Anthropic — **M** · dipende da E8.1
- [ ] SDK ufficiale `@anthropic-ai/sdk`, streaming, uso di strumenti, prompt caching

### E8.3 Adattatore compatibile OpenAI — **M** · dipende da E8.1
- [ ] SDK `openai` con `baseUrl` configurabile
- [ ] Verificato con OpenRouter e Ollama

### E8.4 Chiavi e gateway — **M** · dipende da E8.1, E5.1
- [ ] Chiavi cifrate in `/system/secrets/ai` con la chiave `ai_keys_master`
- [ ] Gateway in `cms-api`: decifra al momento della chiamata, registra `ai_usage`
- [ ] Endpoint interno per `agent-runner`, che non possiede chiavi

### E8.5 Ciclo agente nativo — **M** · dipende da E8.1
- [ ] Ciclo con chiamate agli strumenti, numero massimo di passi, interruzione dall'utente
- [ ] Eventi inoltrati alla chat

### E8.6 Connessioni e ruoli — **S** · dipende da E8.2, E8.3
- [ ] Una connessione attiva usata da tutti i ruoli (TECHNICAL §7.8)
- [ ] "Prova connessione": credenziali, modello, supporto agli strumenti (FR-123, FR-124)

### E8.7 Server MCP degli strumenti — **M** · dipende da E8.1, E4.6
- [ ] `packages/mcp-tools`: registro degli strumenti (Zod + permesso richiesto)
- [ ] Server MCP su HTTP, solo rete `control`
- [ ] Token di sessione con il `Principal`; audit con provider e modello

### E8.8 Motore CLI: Claude Code — **L** · dipende da E8.7, E1.2
- [ ] Avvio di `claude -p` con `--output-format stream-json`, configurazione MCP, `--resume`
- [ ] `CLAUDE_CONFIG_DIR` per utente
- [ ] Parsing dello stream → eventi della chat
- [ ] Rilevazione del limite del piano → stato `rate_limited` e messaggio chiaro

### E8.9 Collegamento dell'abbonamento — **S** · dipende da E8.8
- [ ] Comando `cms-connect claude-code --user <username>` che apre il login ufficiale
- [ ] Stato del collegamento visibile nella scheda AI

---

## E9 — Agente contenuti

### E9.1 Strumenti dei contenuti — **L** · dipende da E8.7, E5.1–E5.7, E6.6
- [ ] `list_nodes`, `read_node`, `create_page`, `update_blocks`, `move_node`, `delete_node`
- [ ] `upload_asset`, `publish`, `update_meta`, `update_layout`, `update_menu`
- [ ] `explain_permission`, `chmod`, `set_acl`
- [ ] Ogni strumento di scrittura restituisce le violazioni HTML

### E9.2 Prompt e contesto — **M** · dipende da E9.1
- [ ] Prompt di sistema: ruolo, regole HTML, comportamento sui permessi negati, conferme
- [ ] Contesto: pagina corrente, outline, elemento selezionato, ambiente, permessi effettivi

### E9.3 Piani e conferme — **M** · dipende da E9.1, E5.7
- [ ] Accumulo delle operazioni di un turno in un piano
- [ ] Anteprima, conferma, esecuzione transazionale
- [ ] Conferma esplicita per le operazioni distruttive (FR-06)

### E9.4 Conflitti — **S** · dipende da E9.3
- [ ] `expectedVersion`; in caso di conflitto l'agente propone l'unione (FR-64)

### E9.5 Conversazioni collegate — **S** · dipende da E9.3, E2.6
- [ ] Ogni versione salva `conversation_id`; dalla versione si apre la conversazione

### E9.6 Profilo agente contenuti — **S** · dipende da E4.2
- [ ] Profilo in `/system/agents/content-agent` con i vincoli I4 e I6

### E9.7 Primo sito via chat — **S** · dipende da E9.1–E9.6, E7.4
- [ ] Scenario end-to-end PRD §6.2: dalla pagina bianca a un sito con header, menu e quattro pagine

---

## E10 — Staging e agente sviluppatore

### E10.1 Repo del sito — **M** · dipende da E1.1, E6.1
- [ ] `site.git` bare nel volume, inizializzato da `templates/site`
- [ ] Rami `main` e `staging`

### E10.2 Manifest e nodi di codice — **M** · dipende da E10.1, E5.1
- [ ] Corrispondenza percorso nell'albero ↔ file
- [ ] Sincronizzazione dei nodi con `storage='git'`

### E10.3 Hook `pre-receive` — **M** · dipende da E10.2, E4.6
- [ ] Per ogni file del push: risoluzione del nodo e verifica di `w`/`c`/`d`
- [ ] Rifiuto con messaggio chiaro

### E10.4 Ciclo di vita del changeset — **M** · dipende da E10.1, E2.5
- [ ] Creazione del ramo `cs/<id>` e del worktree
- [ ] Stati (TECHNICAL §8.1), percorsi toccati, rilevazione dei conflitti tra changeset

### E10.5 DB per changeset — **S** · dipende da E10.4, E1.1
- [ ] `CREATE DATABASE app_cs_<id> TEMPLATE app_staging`, eliminazione alla chiusura

### E10.6 Agente sviluppatore con Claude Code — **L** · dipende da E8.8, E10.4
- [ ] `settings.json` generato nel workspace con regole allow/deny
- [ ] Hook `PreToolUse` che chiama `authz` per file e comandi
- [ ] Allowlist dei comandi; `pnpm add` solo con `CAP_DEPENDENCY_ADD`
- [ ] Strumenti CMS e di sviluppo via MCP: `run_checks`, `get_check_results`, `query_staging_db`, `open_preview`

### E10.7 Agente sviluppatore con motore nativo — **M** · dipende da E8.5, E10.4
- [ ] Strumenti `list_files`, `read_file`, `write_file`, `edit_file`, `search`, `run`, tutti controllati da `authz`

### E10.8 Commit — **S** · dipende da E10.6
- [ ] Commit a fine turno, autore = utente, trailer `Agent`, `AI`, `Conversation`

### E10.9 Anteprime — **M** · dipende da E10.5, E11.2, E1.3
- [ ] `next start` sull'artefatto del changeset, collegato al suo DB
- [ ] Route Caddy `cs-<id>.localhost`, spegnimento alla chiusura

### E10.10 Sito di staging e sincronizzazione — **M** · dipende da E10.1, E5.5
- [ ] `site-staging` sul ramo `staging`
- [ ] Copia di contenuti pubblicati e asset da produzione a staging (`CAP_STAGING_SYNC`)

---

## E11 — Controlli automatici

### E11.1 Worker e code — **S** · dipende da E2.1
- [ ] pg-boss, framework dei job, retry, log

### E11.2 Esecuzione dei controlli — **L** · dipende da E11.1, E1.2, E10.4
- [ ] Nel `builder`: `permissions`, `typecheck`, `lint`, `deps`, `unit`, `migration`, `build`, `html`, `e2e`, `a11y`
- [ ] Rilevazione delle migrazioni distruttive
- [ ] Risultati in `check_runs`

### E11.3 Regole di sicurezza del sito — **M** · dipende da E0.1
- [ ] Plugin ESLint: niente `process.env` fuori da `@site/config`, niente `child_process`, `fs`, `eval`, niente `dangerouslySetInnerHTML` fuori dai componenti approvati

### E11.4 Correzione automatica — **M** · dipende da E11.2, E10.6
- [ ] Errori passati all'agente, al massimo 3 tentativi (FR-42)
- [ ] Stato in tempo reale nella scheda Sviluppo

---

## E12 — Release e rollback

### E12.1 Approva e pubblica — **S** · dipende da E11.2, E4.4
- [ ] Endpoint con controllo di `CAP_RELEASE_APPROVE` e `CAP_RELEASE_DEPLOY`
- [ ] Rifiuto con commento → torna all'agente come richiesta di modifiche

### E12.2 Job di release — **L** · dipende da E12.1
- [ ] Lock globale; rebase su `main` e nuovi controlli se `main` è cambiato
- [ ] Build dell'artefatto in `releases/<id>/`
- [ ] `pg_dump` delle tabelle interessate
- [ ] Migrazioni su `app_prod` in una transazione
- [ ] Cambio del puntatore `current` e riavvio di `site-prod` (nell'MVP 1 è accettato un breve fermo)
- [ ] Health check; in caso di errore, ripristino di artefatto e stato precedenti
- [ ] Merge su `main`, tag `release-<n>`, audit

### E12.3 Rollback — **M** · dipende da E12.2
- [ ] Ritorno all'artefatto della release precedente
- [ ] Nessun ripristino del DB, grazie alla regola "prima si aggiunge, poi si toglie"

### E12.4 Storico — **S** · dipende da E12.2
- [ ] Release con autore, approvatore, data, changeset ed esito

---

## E13 — Accettazione e rifinitura

### E13.1 Suite di accettazione — **L** · dipende da tutto
- [ ] Un test Playwright per ciascun criterio di PRD §9 (1–12)
- [ ] Eseguibile con `make acceptance` sull'ambiente Docker

### E13.2 Test di sicurezza degli agenti — **M** · dipende da E9, E10
- [ ] Richieste fuori dai permessi, bloccate dal motore e non dal prompt
- [ ] Push git non autorizzato rifiutato
- [ ] Nessun agente raggiunge chiavi, segreti o la rete di produzione

### E13.3 Documentazione d'uso — **S** · dipende da tutto
- [ ] Guida al primo avvio: login, collegamento dell'AI, primo sito
- [ ] Guida ai permessi con esempi

---

## Riepilogo

| Epic | Task | Dimensione indicativa |
|---|---|---|
| E0 Repository e strumenti | 3 | M |
| E1 Ambiente Docker | 5 | L |
| E2 Database | 8 | L |
| E3 Autenticazione | 5 | L |
| E4 Motore dei permessi | 8 | XL |
| E5 Albero e contenuti | 7 | XL |
| E6 Sito e regole HTML | 8 | XL |
| E7 Widget | 12 | XL |
| E8 Livello AI | 9 | XL |
| E9 Agente contenuti | 7 | L |
| E10 Staging e agente sviluppatore | 10 | XL |
| E11 Controlli automatici | 4 | L |
| E12 Release e rollback | 4 | L |
| E13 Accettazione | 3 | L |
| **Totale** | **93** | |
