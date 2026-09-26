# Documento tecnico — AI-CMS

> Descrive **come** vengono realizzati i requisiti di `PRD.md`.
> I riferimenti `FR-xx` e `NFR-xx` rimandano al PRD.

| Campo | Valore |
|---|---|
| Stato | Bozza v0.1 |
| Data | 2026-09-26 |
| Obiettivo | Ambiente locale completo in Docker (NFR-01, NFR-02) |

---

## 1. Principi architetturali

1. **Il codice della piattaforma e il codice del sito sono separati.**
   - *Repo piattaforma* (questo repository): cms-api, widget, motore permessi, agenti, pipeline.
     Non viene mai modificato dall'AI.
   - *Repo sito*: il sito generato, gestito dal CMS in un git server locale.
     È l'unico codice che l'agente sviluppatore scrive.
2. **I permessi sono garantiti dall'infrastruttura, non dalle istruzioni all'AI.**
   Ogni strumento dell'agente passa dal motore dei permessi; i container hanno solo
   le credenziali e le reti di cui hanno bisogno.
3. **Un solo punto di applicazione dei permessi** (`packages/authz`), usato da tutti
   i servizi. Nessun accesso diretto al DB che lo aggiri.
4. **Tutto è versionato**: contenuti in tabelle con versioni, codice in git, permessi e
   azioni nell'audit.
5. **Operazioni atomiche**: ogni richiesta che tocca più nodi è una transazione (FR-63);
   ogni release si completa per intero o viene annullata (NFR-05).
6. **Indipendenza dal provider AI.** Gli strumenti del CMS e i permessi sono definiti una
   volta sola e funzionano con qualsiasi modello: chiave API, abbonamento o modello locale.
   Cambiare provider non cambia mai ciò che un agente può fare (FR-132).

---

## 2. Stack

| Area | Scelta | Motivo |
|---|---|---|
| Linguaggio | **TypeScript** (strict) su Node.js 22 LTS | Un linguaggio per tutto; `tsc` è il primo controllo sul codice generato. |
| Monorepo | pnpm workspaces + Turborepo | Pacchetti condivisi tra cms-api, widget, sito e worker. |
| Backend CMS (`cms-api`) | Next.js (solo route handler, nessuna UI di amministrazione) | API, chat in streaming, pagina di login, file del widget. |
| Widget | Web component con Preact, in Shadow DOM, bundle unico con Vite | Interfaccia di gestione dentro le pagine del sito (§10). |
| Regole HTML | `html-validate` + regole proprie | Validità HTML5, titoli, intestazioni, accessibilità (§11). |
| Sito generato | Next.js (App Router) | Pagine statiche con ISR e pagine dinamiche nello stesso runtime. |
| Database | PostgreSQL 17 (con estensione `ltree`) | Albero dei nodi con query sugli antenati efficienti; `CREATE DATABASE … TEMPLATE` per clonare i DB di staging. |
| ORM e migrazioni | Drizzle ORM + drizzle-kit | Schema tipizzato, migrazioni SQL leggibili e revisionabili. |
| Code di lavoro | Tabella `jobs` in PostgreSQL (`@ai-cms/pipeline`): `FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY` | Nessun servizio in più; niente DDL a runtime, compatibile con i ruoli DB separati (pg-boss crea tabelle a runtime). |
| Storage asset | SeaweedFS (API compatibile S3) | Bucket separati per produzione e staging. Licenza Apache 2.0; MinIO non distribuisce più immagini Docker per la versione community. |
| Git server | Repository bare su volume + hook `pre-receive` | Semplice, locale, con controllo permessi anche lato git. |
| Reverse proxy | Caddy | Host `*.localhost`, routing verso anteprime dinamiche. |
| Email (locale) | Mailpit | Inviti e recupero password in sviluppo. |
| AI — chiavi API | Livello provider proprio (`packages/ai`) con gli SDK ufficiali: `@anthropic-ai/sdk`, `openai`, `@google/genai`; adattatore generico compatibile OpenAI per Mistral, OpenRouter, DeepSeek, Ollama, LM Studio, vLLM | Più provider, scelta per ruolo (FR-120, FR-121). Vedi §7. |
| AI — abbonamenti | CLI ufficiali dei provider, non modificate, in modalità non interattiva: Claude Code (`claude -p`), Codex CLI, Gemini CLI | Uso dei piani fissi (§7.4). |
| AI — strumenti | Server MCP interno (`@modelcontextprotocol/sdk`) | Stessi strumenti e stessi permessi per ogni provider. |
| Validazione | Zod | Input degli strumenti AI, API, configurazioni. |
| Autenticazione | Modulo proprio: sessioni server-side, `argon2id`, TOTP (`otplib`) | Pochi requisiti, controllo totale, nessuna dipendenza esterna. |
| Test | Vitest, fast-check (property test), Playwright | Unit, motore permessi, end-to-end. |
| Sanitizzazione HTML | `sanitize-html` lato server | FR-112. |

---

## 3. Architettura dei container

```
                              ┌──────────────── caddy (:80) ────────────────┐
                              │ */_cms/*           → cms-api (stessa origine)│
                              │ www.localhost      → site-prod (blue|green) │
                              │ staging.localhost  → site-staging           │
                              │ cs-<id>.localhost  → previews (per host)    │
                              └──────┬───────────────┬───────────────┬──────┘
                                     │               │               │
  ┌──────────────────────── net: control ────────────┼───────────────┼─────────────┐
  │  cms-api (Next.js)  ◄──►  postgres-core           │               │             │
  │      │   chat, admin,       db: cms_core           │               │             │
  │      │   API, authz         (utenti, albero, ACL,  │               │             │
  │      │                      contenuti, audit)      │               │             │
  │      ▼                                             │               │             │
  │  worker (coda jobs) ── builder ── git (bare repo) ───┼───────────────┤             │
  │      │                                             │               │             │
  │      └──► agent-runner (motori AI + CLI, sandbox)  │               │             │
  └───────────────────────────────────────────────────┼───────────────┼─────────────┘
                                                      │               │
  ┌────────────── net: prod ─────────────┐   ┌────────┴── net: staging ─────────────┐
  │ site-prod-blue / site-prod-green     │   │ site-staging, previews               │
  │ postgres-prod  (db: app_prod)        │   │ postgres-staging (app_staging,       │
  │ s3 (bucket: prod)                    │   │   app_cs_<id>…)                      │
  └──────────────────────────────────────┘   │ s3 (bucket: staging)                 │
                                             └──────────────────────────────────────┘
  egress-proxy: unica uscita verso internet (endpoint dei provider AI configurati, registry npm su autorizzazione)
```

### 3.1 Servizi

| Servizio | Ruolo | Reti | Note di sicurezza |
|---|---|---|---|
| `caddy` | Reverse proxy | tutte | Unico servizio esposto sull'host. |
| `cms-api` | API, chat, login, widget, motore permessi, agente contenuti, **gateway AI**, server MCP degli strumenti | control, prod (solo contenuti), staging | Unico servizio che decifra le chiavi API dei provider. Non ha credenziali di scrittura sul codice di prod. Chiede all'`agent-runner` lo stato dei profili CLI in abbonamento, senza mai leggerne le credenziali. |
| `worker` | Esegue i job della coda `jobs`: controlli, build, release, sincronizzazioni | control, prod, staging | Unico servizio con i ruoli DB di migrazione in prod. |
| `agent-runner` | Esegue l'agente sviluppatore in sandbox, con il motore nativo o con una CLI in abbonamento | control (solo gateway AI e server MCP), egress | **Nessun** accesso alle reti prod e **nessuna chiave API**. Utente non root, filesystem limitato al workspace e al proprio profilo CLI. Dichiara se un login in abbonamento è salvato, senza leggerne il contenuto (FR-126). |
| `builder` | Controlli e build dei changeset (API HTTP interna su `:8090`, chiamata dal worker) | staging | Esegue il codice del sito: nessun segreto della piattaforma, `workspaces` in sola lettura, internet solo tramite `egress-proxy`. Ogni run lavora su una copia privata del monorepo. |
| `git` | Repository bare del sito + hook | control | Hook `pre-receive` che verifica i permessi sui percorsi (difesa in profondità). |
| `postgres-core` | DB della piattaforma | control | Ruoli distinti per cms-api, worker e audit. |
| `postgres-prod` | Dati applicativi di produzione | prod | Raggiungibile solo da `site-prod`, `cms-api` (ruolo limitato) e `worker`. |
| `postgres-staging` | Dati applicativi di staging e di ogni changeset | staging | Un DB per changeset, clonato da template. |
| `site-prod-blue/green` | Runtime del sito pubblico | prod | Filesystem in sola lettura, utente non root, artefatto di release montato in sola lettura. |
| `site-staging` | Runtime staging (ramo `staging`) | staging | |
| `previews` | Anteprime dei changeset | staging | Un processo per changeset attivo, porte dinamiche. |
| `s3` | Asset (SeaweedFS con API S3) | control, prod, staging | Bucket separati per ambiente. |
| `egress-proxy` | Uscita verso internet con allowlist | egress | FR-111. |
| `mailpit` | SMTP locale | control | |
| `ollama` *(opzionale)* | Modelli locali | control | Attivabile con il profilo Compose `local-ai`. |

### 3.2 Volumi

| Volume | Contenuto |
|---|---|
| `pg-core`, `pg-prod`, `pg-staging` | Dati PostgreSQL |
| `git-repos` | Repository bare `site.git` |
| `workspaces` | Worktree git dei changeset (scritto da `worker` e `agent-runner`, in sola lettura nel `builder`) |
| `artifacts` | Artefatti dei changeset: `artifacts/<changeset_id>/<commit>/` e `preview.json` (scritto dal `builder`, in sola lettura in `previews`) |
| `releases` | Artefatti di build: `releases/<release_id>/`, più i puntatori `blue` e `green` |
| `backups` | Dump pre-migrazione (FR-56) |
| `s3-data` | Asset |
| `cli-auth` | Profili di login delle CLI in abbonamento, una cartella per utente (`cli-auth/<uid>/<provider>`). Montato **solo** in `agent-runner`. |

---

## 4. Struttura del repository piattaforma

```
ai-cms/
├── apps/
│   ├── cms-api/              Next.js: API, chat in streaming, login, serve il widget
│   └── worker/               job in coda: pipeline, release, sync
├── packages/
│   ├── authz/                motore permessi (puro, senza I/O) + adattatore DB
│   ├── db/                   schema Drizzle di cms_core, migrazioni, seed
│   ├── tree/                 servizio nodi: CRUD sull'albero, sempre tramite authz
│   ├── content/              modello a blocchi, versioni, pubblicazione, sanitizzazione
│   ├── widget/               web component <cms-widget> (Preact + Shadow DOM)
│   ├── html-rules/           regole HTML: validazione, titoli, head, accessibilità
│   ├── ai/                   livello provider: motori chat (API/locali), motori CLI,
│   │                         gateway, instradamento e riserve, consumi
│   ├── mcp-tools/            strumenti del CMS (Zod) + server MCP
│   ├── agents/
│   │   ├── content-agent/    prompt e configurazione dell'agente contenuti
│   │   └── dev-agent/        motore nativo di coding, hook sui permessi per le CLI
│   ├── pipeline/             definizione dei controlli e della release
│   ├── audit/                scrittura append-only con catena di hash
│   ├── auth/                 sessioni, password, TOTP, token API
│   └── site-kit/             libreria usata dal sito generato: renderer dei blocchi,
│                             accesso ai contenuti, config, client DB autorizzato
├── templates/
│   └── site/                 scheletro iniziale del repo sito
├── docker/
│   ├── compose.yml
│   ├── caddy/Caddyfile
│   ├── git/hooks/pre-receive
│   └── images/               Dockerfile di cms-api, worker, agent-runner, site-runtime
├── PRD.md
└── TECHNICAL.md
```

### 4.1 Struttura del repo sito (generato)

```
site/
├── app/                         Next.js App Router
│   ├── [[...slug]]/page.tsx     catch-all: rende le pagine statiche dai contenuti
│   └── (dynamic)/…              pagine dinamiche scritte dall'agente
├── pages-code/<page-path>/      codice associato ai nodi pagina dinamici
├── components/
├── api/                         endpoint (esposti tramite route handler)
├── lib/
├── db/
│   ├── schema/                  schema Drizzle delle collezioni
│   └── migrations/
├── tests/                       unit ed e2e generati insieme al codice
└── cms.manifest.json            mappa percorsi albero ↔ file (vedi 6.6)
```

Il catch-all rende tutte le pagine statiche leggendo i contenuti pubblicati. Aggiungere o
modificare una pagina statica **non richiede un deploy**. Solo le pagine con codice
passano dalla pipeline.

---

## 5. Modello dati (`cms_core`)

### 5.1 Identità

```sql
CREATE TABLE groups (
  gid    integer PRIMARY KEY,
  name   citext UNIQUE NOT NULL,
  system boolean NOT NULL DEFAULT false               -- gruppi predefiniti
);

CREATE TABLE users (
  uid            integer PRIMARY KEY,                -- 0 = root
  username       citext  UNIQUE NOT NULL,
  email          citext  UNIQUE NOT NULL,
  password_hash  text,                                -- argon2id
  totp_secret    bytea,                               -- cifrato
  primary_gid    integer NOT NULL REFERENCES groups(gid),
  kind           text NOT NULL CHECK (kind IN ('human','service','agent')),
  status         text NOT NULL CHECK (status IN ('invited','active','suspended','deleted')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
  gid        integer REFERENCES groups(gid),
  uid        integer REFERENCES users(uid),
  expires_at timestamptz,                             -- FR-76
  PRIMARY KEY (gid, uid)
);

CREATE TABLE capability_grants (
  id           bigserial PRIMARY KEY,
  capability   text NOT NULL,                         -- 'CAP_RELEASE_APPROVE', …
  subject_type text NOT NULL CHECK (subject_type IN ('user','group')),
  subject_id   integer NOT NULL,
  expires_at   timestamptz
);

CREATE TABLE sessions   (…);   -- id hashato, uid, scadenza, ultimo uso, IP, user agent
CREATE TABLE api_tokens (…);   -- hash, uid proprietario, maschera di permessi, scadenza (FR-75)
```

### 5.2 Albero dei nodi e permessi

```sql
CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TABLE nodes (
  id          uuid PRIMARY KEY,
  parent_id   uuid REFERENCES nodes(id),
  name        text  NOT NULL,                        -- segmento del percorso
  path        ltree NOT NULL UNIQUE,                 -- es. site.pages.blog.primo_post
  kind        text  NOT NULL,                        -- dir, page, block, asset, collection,
                                                     -- file, menu, layout, setting, secret…
  storage     text  NOT NULL CHECK (storage IN ('db','git','s3','virtual')),
  env         text  NOT NULL CHECK (env IN ('prod','staging','both')),
  owner_uid   integer NOT NULL REFERENCES users(uid),
  gid         integer NOT NULL REFERENCES groups(gid),
  mode        integer NOT NULL,                      -- 3 × 8 bit: u<<16 | g<<8 | o
  acl_mask    smallint,                              -- NULL = nessuna maschera
  attrs       integer NOT NULL DEFAULT 0,            -- setgid, sticky, immutable, append-only
  version     bigint  NOT NULL DEFAULT 1,            -- per concorrenza ottimistica (FR-64)
  deleted_at  timestamptz,                           -- cestino (FR-66)
  UNIQUE (parent_id, name)
);
CREATE INDEX nodes_path_gist ON nodes USING gist (path);

CREATE TABLE acl_entries (
  id          bigserial PRIMARY KEY,
  node_id     uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  effect      text NOT NULL CHECK (effect IN ('allow','deny')),
  subject     text NOT NULL CHECK (subject IN ('user','group')),
  subject_id  integer NOT NULL,
  perms       smallint NOT NULL,                     -- bitmask degli 8 permessi
  env         text NOT NULL DEFAULT 'both',          -- FR-81
  is_default  boolean NOT NULL DEFAULT false,        -- ACL di default ereditabile (FR-79)
  expires_at  timestamptz
);
```

**Codifica dei permessi** (`packages/authz/src/perms.ts`):

| Bit | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |
|---|---|---|---|---|---|---|---|---|
| Permesso | `m` | `p` | `d` | `c` | `w` | `x` | `l` | `r` |

**Attributi**: `SETGID=1`, `STICKY=2`, `IMMUTABLE=4`, `APPEND_ONLY=8`.

### 5.3 Contenuti

```sql
CREATE TABLE content_versions (
  id          bigserial PRIMARY KEY,
  node_id     uuid NOT NULL REFERENCES nodes(id),
  env         text NOT NULL,                         -- prod | staging
  version     bigint NOT NULL,
  body        jsonb NOT NULL,                        -- blocchi e metadati (schema Zod)
  author_uid  integer NOT NULL,
  via_agent   text,                                  -- NULL se modifica manuale
  conversation_id uuid,                              -- FR-08
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, env, version)
);

CREATE TABLE publications (
  node_id       uuid NOT NULL REFERENCES nodes(id),
  env           text NOT NULL,
  version_id    bigint NOT NULL REFERENCES content_versions(id),
  status        text NOT NULL CHECK (status IN ('published','scheduled','archived')),
  publish_at    timestamptz,                         -- FR-26
  published_by  integer NOT NULL,
  PRIMARY KEY (node_id, env)
);

-- Vista letta dal sito in sola lettura (ruolo DB: site_content_ro)
CREATE VIEW published_content AS …;
```

### 5.4 Sviluppo e release

```sql
CREATE TABLE changesets (
  id           uuid PRIMARY KEY,
  title        text NOT NULL,
  branch       text NOT NULL,                        -- cs/<id>
  base_commit  text NOT NULL,
  head_commit  text,
  author_uid   integer NOT NULL,
  status       text NOT NULL,                        -- vedi macchina a stati 8.1
  touched_paths ltree[] NOT NULL DEFAULT '{}',       -- per rilevare i conflitti (FR-65)
  destructive_migration boolean NOT NULL DEFAULT false,
  conversation_id uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE check_runs (
  id            bigserial PRIMARY KEY,
  changeset_id  uuid NOT NULL REFERENCES changesets(id),
  commit        text NOT NULL,
  check_name    text NOT NULL,                       -- typecheck, lint, unit, build, …
  status        text NOT NULL,                       -- queued, running, passed, failed
  output        text,
  started_at    timestamptz,
  finished_at   timestamptz
);

CREATE TABLE reviews  (changeset_id uuid, reviewer_uid integer, decision text, comment text, …);
CREATE TABLE releases (id uuid, changeset_ids uuid[], commit text, artifact_path text,
                       backup_path text, status text, approved_by integer,
                       deployed_by integer, previous_release_id uuid, …);
```

### 5.5 Audit

```sql
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_uid   integer NOT NULL,                      -- utente
  agent       text,                                  -- 'content-agent', 'dev-agent', NULL
  action      text NOT NULL,                         -- node.write, authz.deny, release.deploy…
  node_path   ltree,
  env         text,
  outcome     text NOT NULL,                         -- allowed, denied, ok, error
  details     jsonb,                                 -- include la spiegazione della decisione
  prev_hash   bytea NOT NULL,
  hash        bytea NOT NULL                         -- sha256(prev_hash || riga)
);
```

- Il ruolo `audit_writer` ha solo `INSERT`; nessun ruolo ha `UPDATE` o `DELETE`.
- Un trigger `BEFORE UPDATE OR DELETE` solleva un'eccezione anche per il proprietario della tabella.
- La catena di hash permette di rilevare manomissioni fatte a livello di superuser Postgres (FR-101).
- Un job periodico verifica la catena.

---

## 6. Motore dei permessi (`packages/authz`)

> **Fase 1 (MVP 1):** `authz` applica solo i vincoli di sistema (§6.3), i profili agente e lo
> scope; poi consente tutto agli utenti autenticati e attivi (politica "tutti admin"). Le
> tabelle e l'algoritmo di questa sezione arrivano in fase 2 come nuova politica, senza
> cambiare i chiamanti. Vedi `MVP1.md`, sezione *Fase 2 — Permessi*.

### 6.1 Interfaccia

```ts
type Perm = 'r' | 'l' | 'x' | 'w' | 'c' | 'd' | 'p' | 'm';
type Env  = 'prod' | 'staging';

interface Principal {
  uid: number;
  gids: number[];                 // gruppo primario + gruppi non scaduti
  capabilities: Set<Capability>;
  agentProfile?: AgentProfile;    // presente se agisce un agente (FR-82)
  tokenMask?: PermMask;           // presente se autenticato con token API
  scope?: string[];               // restrizione per conversazione (FR-86)
}

interface Decision {
  allowed: boolean;
  steps: DecisionStep[];          // spiegazione passo per passo (FR-88)
}

function check(p: Principal, action: Perm, target: NodeWithAncestors, env: Env): Decision;
function requireCap(p: Principal, cap: Capability): Decision;
```

Il cuore (`check`) è una **funzione pura**: riceve il nodo con i suoi antenati, le ACL e il
principal, e restituisce la decisione. Nessun I/O, quindi è testabile in modo esaustivo.

### 6.2 Algoritmo

```ts
function check(p, action, node, env): Decision {
  const trace = new Trace();

  // 1. Vincoli di sistema: non aggirabili, nemmeno da root
  const inv = systemInvariants(p, action, node, env);
  if (inv) return trace.deny('invariant', inv);

  // 2. Restrizioni dell'agente, del token e dello scope (intersezione)
  if (p.agentProfile && !p.agentProfile.allows(action, node, env))
    return trace.deny('agent-profile');
  if (p.tokenMask && !(p.tokenMask & bit(action))) return trace.deny('token-mask');
  if (p.scope && !inScope(node.path, p.scope))    return trace.deny('scope');

  // 3. root: salta i passi 4–6
  if (p.uid === 0) return trace.allow('root');

  // 4. Attraversamento: x su ogni antenato
  for (const anc of node.ancestors) {
    if (!(effective(p, anc, env) & X)) return trace.deny('traverse', anc.path);
  }

  // 5. Negazioni esplicite
  const deny = matchingAcl(p, node, env, 'deny').find(e => e.perms & bit(action));
  if (deny) return trace.deny('acl-deny', deny);

  // 6. Permesso effettivo, con una sola classe come in POSIX
  const eff = effective(p, node, env);
  let ok = (eff & bit(action)) !== 0;

  // 6b. Attributi: sticky sulla cartella padre
  if (ok && (action === 'd') && node.parent.attrs & STICKY
      && p.uid !== node.owner_uid && p.uid !== node.parent.owner_uid)
    return trace.deny('sticky');

  return ok ? trace.allow('mode/acl', eff) : trace.deny('mode/acl', eff);
}

function effective(p, n, env): number {
  if (p.uid === n.owner_uid) return owner(n.mode);                       // classe u
  const mask = n.acl_mask ?? 0xff;
  const userAce = allowAcl(n, env).find(e => e.subject === 'user' && e.subject_id === p.uid);
  if (userAce) return userAce.perms & mask;                                // named user
  const groupAces = allowAcl(n, env).filter(e => e.subject === 'group' && p.gids.includes(e.subject_id));
  if (p.gids.includes(n.gid) || groupAces.length)                          // classe g
    return (orAll(groupAces) | (p.gids.includes(n.gid) ? group(n.mode) : 0)) & mask;
  return other(n.mode);                                                    // classe o
}
```

Come in POSIX, **se l'utente rientra in una classe, le classi successive non vengono considerate**.
Esempio: se il gruppo ha meno permessi di `other`, un membro del gruppo ha comunque solo i
permessi del gruppo. È voluto: permette di escludere un gruppo con `g=---`.

### 6.3 Vincoli di sistema (passo 1)

| # | Vincolo |
|---|---|
| I1 | In `env=prod`, le azioni `w`, `c` e `d` sui nodi con `storage='git'` (codice) e sugli schemi delle collezioni sono vietate. |
| I2 | Un nodo con attributo `IMMUTABLE` non accetta `w`, `d` o `m` (tranne togliere l'attributo con `CAP_ATTR`). |
| I3 | Un nodo con attributo `APPEND_ONLY` accetta `c`, ma non `w` o `d` sui figli esistenti. |
| I4 | Nessun agente riceve `m` su `/system/**` o `r` su `/system/secrets/**` (FR-85). |
| I5 | L'agente sviluppatore non può operare in `env=prod` (FR-84). |
| I6 | L'agente contenuti non può toccare nodi con `storage='git'` né gli schemi (FR-83). |
| I7 | `/system/audit` è in sola lettura per tutti, root compreso. |

### 6.4 Ereditarietà alla creazione

Quando si crea un nodo figlio dentro la cartella `D`:

- `owner_uid` = chi crea;
- `gid` = `D.gid` se `D` ha `SETGID`, altrimenti il gruppo primario di chi crea;
- `mode` = mode di default del tipo di nodo, meno la `umask` dell'utente;
- le ACL di `D` con `is_default=true` vengono copiate sul figlio (come ACL normali e,
  se il figlio è una cartella, anche come default);
- se `D` ha `SETGID` e il figlio è una cartella, il figlio eredita anche `SETGID`.

### 6.5 Prestazioni (NFR-04)

- Il caricamento del nodo con antenati e ACL avviene in **una sola query**, grazie a
  `ltree` (`WHERE path @> $target`) più un join sulle ACL.
- Nella stessa richiesta, le decisioni sono memorizzate per `(uid, node_id, action, env)`.
- Cache LRU tra richieste sui nodi, con chiave `node_id:version`. L'invalidazione avviene
  con `LISTEN/NOTIFY` di PostgreSQL a ogni modifica di mode, ACL, gruppi o appartenenze.
- **"Chi può?"** (FR-89) è una query al contrario, calcolata sui candidati (proprietario,
  soggetti delle ACL, membri dei gruppi coinvolti, e `other`) e verificata con `check`.

### 6.6 Nodi di codice

I file del repo sito sono rappresentati come nodi con `storage='git'`. Il file
`cms.manifest.json` e il servizio `tree` tengono allineata la corrispondenza tra percorso
nell'albero e file nel repo, ad esempio:

```
/site/pages/catalogo/page.tsx   ↔   app/(dynamic)/catalogo/page.tsx
/code/api/contatti.ts            ↔   api/contatti.ts
/data/collections/prodotti/schema ↔ db/schema/prodotti.ts
```

I permessi sono controllati **in due punti**:

1. negli strumenti dell'agente, prima di scrivere il file;
2. nell'hook git `pre-receive`, che per ogni file modificato nel push risolve il nodo e
   verifica `w`, `c` o `d` per l'utente associato al push. Un push fatto aggirando gli
   strumenti viene rifiutato comunque.

### 6.7 Record delle collezioni

I singoli record **non** sono nodi (potrebbero essere milioni). I permessi sono:

- a livello di collezione: `r` e `l` per leggere, `c` per inserire, `w` per modificare, `d` per eliminare;
- con `STICKY` sulla collezione, ogni record ha una colonna `_owner_uid` e `w`/`d` valgono
  solo per i propri record;
- con `APPEND_ONLY`, i record si possono solo inserire (es. ordini, log).

Il client DB di `site-kit` applica queste regole per le operazioni fatte tramite il CMS.
Per le operazioni dei visitatori valgono le regole scritte nel codice del sito, verificate in revisione.

### 6.8 Applicazione dei permessi nel codice

- Tutti i servizi (`tree`, `content`, `pipeline`, …) ricevono un `RequestContext` con il
  `Principal`. Ogni metodo pubblico chiama `authz.require(...)` come prima istruzione.
- Una regola ESLint impedisce di importare `packages/db` fuori da `tree`, `content`,
  `pipeline`, `auth` e `audit`: le route e gli agenti non possono accedere al DB direttamente.
- Ogni decisione negativa e ogni decisione su azioni sensibili (`p`, `m`, `d`, capability)
  viene scritta nell'audit con la sua spiegazione.

---

## 7. Agenti AI e provider

### 7.1 Panoramica

```
                 ┌────────────── packages/mcp-tools ──────────────┐
                 │ strumenti CMS (Zod) → authz → tree/content/…   │
                 └───────▲───────────────────────────▲────────────┘
                         │ chiamata diretta           │ MCP (HTTP interno, token per sessione)
        ┌────────────────┴─────────┐      ┌───────────┴──────────────────────┐
        │ Motore NATIVO             │      │ Motore CLI (abbonamento)         │
        │ il nostro ciclo agente    │      │ Claude Code / Codex / Gemini CLI │
        │ su un ChatEngine          │      │ con login personale dell'utente  │
        └────────────┬──────────────┘      └───────────┬──────────────────────┘
                     │                                 │ diretto verso il provider
                     ▼                                 ▼
        gateway AI (cms-api): chiavi, consumi,     api del provider (piano fisso)
        limiti di spesa, riserve
                     │
        ┌────────────┼──────────────┬──────────────────────┐
        ▼            ▼              ▼                      ▼
    anthropic      openai        google        openai-compatible
                                              (Mistral, OpenRouter, DeepSeek,
                                               Ollama, LM Studio, vLLM…)
```

Due idee reggono tutto:

1. **Gli strumenti sono uno solo.** Ogni strumento del CMS è definito una volta in
   `packages/mcp-tools`, con schema Zod e permesso richiesto. Il motore nativo li chiama
   direttamente; le CLI li ricevono tramite un **server MCP** interno. I permessi vengono
   verificati lato server in entrambi i casi (FR-132).
2. **Due tipi di motore.** Il *motore nativo* gira il ciclo agente sul nostro codice e
   funziona con qualsiasi modello via API o locale. Il *motore CLI* delega il ciclo a una
   CLI ufficiale e permette di usare gli abbonamenti.

### 7.2 Motori chat (chiavi API e modelli locali)

```ts
interface ChatEngine {
  provider: 'anthropic' | 'openai' | 'google' | 'openai-compatible';
  capabilities(model: string): Promise<ModelCaps>;   // tools, vision, contesto, streaming
  stream(req: ChatRequest): AsyncIterable<ChatEvent>; // text | tool_call | usage | done
}

interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];        // formato normalizzato del CMS
  tools: ToolSpec[];              // JSON Schema generato da Zod
  maxOutputTokens?: number;
}
```

- Un **adattatore per provider**, scritto con l'SDK ufficiale, traduce messaggi e strumenti
  nel formato del provider e normalizza le risposte in `ChatEvent`.
- Le funzioni specifiche utili vengono sfruttate dove esistono (es. prompt caching di
  Anthropic), senza cambiare l'interfaccia.
- L'adattatore `openai-compatible` richiede solo `baseUrl` e chiave, e copre la maggior parte
  dei provider minori e dei modelli locali.
- `capabilities` arriva dalle API dei modelli quando disponibili, altrimenti da una tabella
  di configurazione modificabile. Un ruolo che richiede strumenti rifiuta modelli senza tool
  calling (FR-124).

**Gateway AI.** Tutte le chiamate via chiave API passano dal `cms-api`:

- decifra la chiave solo al momento della chiamata (le chiavi stanno cifrate in
  `/system/secrets/ai/*`, FR-127);
- registra i consumi in `ai_usage` e applica i limiti di spesa (FR-129, FR-130);
- gestisce errori, limiti di frequenza e passaggio alla riserva (FR-122).

Così `agent-runner` non possiede mai una chiave API, anche quando usa il motore nativo.

### 7.3 Server MCP degli strumenti

- Esposto dal `cms-api` solo sulla rete `control`, con trasporto HTTP.
- Ogni esecuzione di un agente riceve un **token di sessione** di breve durata che contiene
  il `Principal`: utente, profilo agente, ambiente, changeset, eventuale scope (FR-86).
- Il server rifiuta qualsiasi chiamata senza token valido e registra tutto nell'audit
  con provider e modello usati.

### 7.4 Abbonamenti (motore CLI)

**Come funziona.** Nell'immagine di `agent-runner` sono installate le CLI ufficiali,
**senza modifiche**. Per ogni esecuzione il CMS avvia la CLI in modalità non interattiva
con output JSON, ad esempio per Claude Code:

```bash
CLAUDE_CONFIG_DIR=/cli-auth/<uid>/claude \
claude -p "<richiesta>" \
  --output-format stream-json --verbose \
  --mcp-config /run/cms/mcp.json \
  --permission-mode default \
  --resume <sessione>              # per continuare la conversazione
```

Il `worker` legge lo stream JSON e lo inoltra alla chat del CMS.

**Login.** Ogni utente collega il **proprio** abbonamento con la procedura ufficiale del
provider, che salva le credenziali nel suo profilo in `cli-auth/<uid>/<provider>`:

```bash
# fase 1, da terminale
docker compose exec -it agent-runner cms-connect claude-code --user <username>
```

Il comando apre il login della CLI; l'autenticazione si completa sul sito del provider.
Il CMS non riceve e non salva mai credenziali o token dell'account (FR-126). Il volume
`cli-auth` è montato solo in `agent-runner`.

**Stato del collegamento.** La scheda AI mostra a ogni utente se il proprio login è salvato.
Poiché il volume `cli-auth` è montato solo in `agent-runner`, è quell'unico servizio che può
rispondere: `cms-api` lo interroga su `POST /cli-auth/status` con un token di sessione breve
(`AGENT_RUNNER_URL`). La risposta riguarda **solo l'utente autenticato**, mai un nome utente
scelto dal chiamante, e consiste nel controllare che il file delle credenziali esista e non sia
vuoto: il contenuto non è mai letto. Se l'`agent-runner` non risponde, lo stato è sconosciuto e
la scheda lo dice, senza bloccare la pagina.

**Regole d'uso** (dai termini di Anthropic per Claude Code; per le altre CLI vanno verificati
i termini del provider prima di abilitarle):

| Consentito | Non consentito |
|---|---|
| Un utente fa il login con il proprio abbonamento nella CLI ufficiale non modificata | Condividere un abbonamento tra più utenti del CMS (FR-125) |
| Usare la CLI per il lavoro che l'utente avvia dalla chat | Usare le credenziali dell'abbonamento dentro il nostro codice, in un SDK o nel gateway |
| | Chiedere all'utente username, password o token dell'account |

Conseguenze nel design:

- il motore CLI gira **sempre** con il profilo dell'utente che ha avviato la richiesta;
  se l'utente non ha un abbonamento collegato, si usa la riserva o si mostra un errore;
- i lavori automatici in background (revisione AI in pipeline, traduzioni in blocco)
  usano per default una chiave API o un modello locale, non l'abbonamento: i limiti dei
  piani presuppongono un uso individuale ordinario;
- il Claude Agent SDK si usa **solo** con chiave API, mai con il login dell'abbonamento.

**Limiti del piano.** Quando la CLI segnala il limite raggiunto, la connessione passa allo
stato `rate_limited` fino all'orario di ripristino indicato, e il ruolo usa la riserva (FR-122).

### 7.5 Agente contenuti

- **Motore:** nativo per default. Con una CLI in abbonamento, tutti gli strumenti nativi
  della CLI (file, shell, web) sono disattivati e sono consentiti solo gli strumenti MCP del CMS.
- **Strumenti** (definiti in `packages/mcp-tools`):

| Strumento | Permesso richiesto |
|---|---|
| `list_nodes(path)` | `l` sulla cartella |
| `read_node(path)` | `r` |
| `create_page(parent, name, blocks, meta)` | `c` sul padre |
| `update_blocks(path, patch, expectedVersion)` | `w` |
| `move_node(path, newParent)` | `d` sul nodo + `c` sul nuovo padre |
| `delete_node(path)` | `d` (con conferma, FR-06) |
| `upload_asset(parent, file)` | `c` |
| `publish(path, at?)` | `p` |
| `explain_permission(user, path, action)` | `r` sul nodo |
| `set_acl(path, entries)` / `chmod(path, mode)` | `m` (con anteprima dell'effetto) |

- Le operazioni proposte in un turno vengono accumulate in un **piano**. L'utente vede
  l'anteprima e conferma; la conferma esegue il piano in **una sola transazione** (FR-63).
- `expectedVersion` realizza la concorrenza ottimistica: se il nodo è cambiato nel
  frattempo, lo strumento restituisce un conflitto e l'agente propone l'unione (FR-64).

### 7.6 Agente sviluppatore

Il workspace è sempre un `git worktree` del ramo `cs/<id>` dentro `agent-runner`.

**Con il motore nativo** (chiave API o modello locale) l'agente ha strumenti di coding
nostri, tutti controllati da `authz`: `list_files`, `read_file`, `write_file`, `edit_file`,
`search`, `run(command)`, più gli strumenti CMS e `run_checks()`, `get_check_results()`,
`query_staging_db(sql)` (sola lettura sul DB del changeset), `open_preview()`.

**Con il motore CLI** (abbonamento) la CLI usa i propri strumenti su file e shell, limitati così:

| Livello | Claude Code | Altre CLI |
|---|---|---|
| Configurazione | `settings.json` generato nel workspace con regole allow/deny sugli strumenti | Opzioni di sandbox e approvazione della CLI |
| Controllo per azione | Hook `PreToolUse` che chiama `authz` per ogni lettura, scrittura o comando | — |
| Container | Solo workspace e profilo CLI montati; rete solo verso il provider e il server MCP | uguale |
| Commit | Hook git `pre-receive` (§6.6) | uguale |
| Pipeline | Controllo `permissions` (§8.2) | uguale |

Anche quando una CLI offre meno punti di controllo, **nessun file non autorizzato arriva
in un changeset**: l'hook git e la pipeline lo bloccano comunque.

**Regole comuni:**

- la shell accetta solo comandi in allowlist (`pnpm tsc`, `pnpm test`, `pnpm lint`,
  `pnpm drizzle-kit generate`, `git status`, `git diff`);
- `pnpm add` richiede che l'utente abbia `CAP_DEPENDENCY_ADD` (FR-37), altrimenti
  l'agente produce una richiesta di approvazione;
- al termine di ogni turno si fa un commit sul ramo, con autore = utente e trailer
  `Agent: dev-agent`, `AI: <connessione>/<modello>`, `Conversation: <id>`.

### 7.7 Configurazione: connessioni, ruoli e profili

Tutto vive nell'albero, sotto `/system/ai`, ed è modificabile con `CAP_AGENT_CONFIG`.

**Connessioni** (`/system/ai/connections/<id>`):

```jsonc
{ "id": "claude-sub",    "type": "subscription", "cli": "claude-code" }
{ "id": "anthropic-key", "type": "api",   "provider": "anthropic",
  "secret": "/system/secrets/ai/anthropic", "scope": "shared" }        // o "personal" (FR-128)
{ "id": "openrouter",    "type": "api",   "provider": "openai-compatible",
  "baseUrl": "https://openrouter.ai/api/v1", "secret": "/system/secrets/ai/openrouter" }
{ "id": "ollama",        "type": "local", "provider": "openai-compatible",
  "baseUrl": "http://ollama:11434/v1" }
```

**Ruoli** (`/system/ai/roles/<ruolo>`), con modello principale e riserve in ordine:

```jsonc
{
  "role": "dev-agent",
  "primary":  { "connection": "claude-sub" },
  "fallback": [{ "connection": "anthropic-key", "model": "claude-opus-5-5" }],
  "requires": ["tools"]
}
```

Ruoli previsti: `content-agent`, `dev-agent`, `ai-review`, `translate`, `alt-text`.

**Profili agente** (`/system/agents/<nome>`): la maschera di permessi, indipendente dal modello:

```jsonc
{
  "name": "content-agent",
  "envs": ["prod", "staging"],
  "allow": [{ "path": "site.**", "perms": "rlxwcdp", "storage": ["db", "s3"] }],
  "deny":  [{ "path": "system.**", "perms": "m" }]
}
```

I permessi dell'agente sono `permessi_utente ∩ profilo`, applicati al passo 2 dell'algoritmo.

**Consumi** (`ai_usage`): utente, ruolo, connessione, modello, tipo (api, subscription,
local), token in ingresso e uscita, costo stimato (da una tabella prezzi modificabile), esito.

### 7.8 Fase 1

Per partire semplici:

- **una sola connessione** usata per tutti i ruoli, scelta al primo avvio;
- adattatori implementati per primi: **Claude Code** (abbonamento), **Anthropic** (API) e
  **openai-compatible** (che copre subito OpenRouter, Mistral, DeepSeek e Ollama);
- dopo: adattatori nativi OpenAI e Google, CLI Codex e Gemini, riserve, limiti di spesa,
  cruscotto consumi.

---

## 8. Pipeline di sviluppo e release

### 8.1 Macchina a stati del changeset

```
draft ──► checking ──► checks_failed ──(agente corregge)──► checking
                  └──► ready ──┬──(clic "Approva e pubblica")──► releasing ──► released
                               │                                          └──► release_failed
                               └──(rifiuto con commento)──► draft
released ──► rolled_back
```

### 8.2 Controlli (FR-40, FR-41)

Eseguiti dal `worker` nel container `builder`, sul commit di testa del changeset:

| Ordine | Controllo | Dettaglio |
|---|---|---|
| 1 | `permissions` | Tutti i file toccati sono consentiti all'autore (rieseguito lato server). |
| 2 | `typecheck` | `tsc --noEmit` |
| 3 | `lint` | ESLint con regole di sicurezza del sito: niente `process.env` fuori da `@site/config`, niente `child_process`, `fs` o `eval`, niente `dangerouslySetInnerHTML` fuori dai componenti approvati. |
| 4 | `deps` | Il lockfile non contiene dipendenze nuove non approvate. |
| 5 | `unit` | Vitest |
| 6 | `migration` | Applicazione sul DB del changeset. Analisi dell'SQL: `DROP`, `RENAME`, `ALTER … TYPE` o `NOT NULL` senza default impostano `destructive_migration=true`: il pulsante di approvazione mostra un avviso e chiede una conferma esplicita. |
| 7 | `build` | `next build`, che produce l'artefatto candidato. |
| 8 | `e2e` | Playwright sulle pagine toccate e sulle pagine critiche (home, 404). |
| 9 | `html` | Regole HTML (§11) su tutte le pagine toccate. |
| 10 | `a11y` | axe-core sulle pagine toccate (NFR-07). |
| 11 | `ai-review` | Un secondo modello esamina il diff e segnala problemi (FR-43). È solo consultivo, non blocca. |

Esecuzione (MVP 1, job `changeset.check`):

- Il worker registra il lavoro (`recordWork`), porta il changeset in `checking`, crea un
  `check_run` per controllo e ne aggiorna stato e output (al massimo 64 KB) man mano.
  Alla fine il changeset va in `ready` se ogni controllo è `passed` o `skipped`, altrimenti in
  `checks_failed`.
- `permissions` e `migration` girano nel worker: non eseguono codice del sito e usano
  credenziali che il builder non deve avere. Le migrazioni sono i file `.sql` di
  `db/migrations`, applicati in ordine, ciascuno in una transazione, e registrati in
  `_cms.migrations` nel DB del changeset (le migrazioni già presenti nel commit di base sono
  considerate applicate). Se una migrazione già applicata cambia, il DB del changeset viene
  ricreato da `app_staging`. Una migrazione distruttiva non fa fallire il controllo ma imposta
  `destructive_migration`.
- Gli altri controlli girano nel `builder`, su una copia privata del monorepo in cui
  `templates/site` è sostituito dal commit del changeset (`git archive`). `deps` è
  `pnpm install --frozen-lockfile --offline` sul lockfile della piattaforma: una dipendenza
  nuova fa fallire il controllo e richiede l'approvazione di un amministratore. `lint` usa una
  configurazione del builder (il sito non può cambiarla né disattivarla con commenti).
  `unit` è `skipped` se il sito non ha test. `build` salva l'artefatto in
  `artifacts/<changeset_id>/<commit>/`.
- `e2e` nell'MVP è uno smoke test HTTP (le pagine pubblicate rispondono 200, una pagina
  inesistente 404), senza Playwright. `a11y` è `skipped`: axe-core richiede un browser; le
  regole WCAG verificabili sull'HTML sono già nel controllo `html`. `ai-review` non c'è.

Se un controllo fallisce, il suo output viene passato all'agente sviluppatore, che può
riprovare fino a `maxAutoFixAttempts` volte (default 3) (FR-42).

### 8.3 DB e anteprima per ogni changeset

- `app_staging` è il database di staging, aggiornato con i contenuti e i dati di esempio.
- Per ogni changeset: `CREATE DATABASE app_cs_<id> TEMPLATE app_staging`. È una copia
  istantanea a livello di file e sostituisce il branching di Supabase.
- `previews` avvia `next start` sull'artefatto del changeset, collegato al suo DB, e Caddy
  lo espone su `cs-<id>.localhost`.
- Alla chiusura del changeset, DB e anteprima vengono eliminati.
- Dopo ogni `build` riuscita il builder scrive `artifacts/<changeset_id>/preview.json`
  (commit, percorso del server standalone, `DATABASE_URL` del DB del changeset con il ruolo
  `site_app`). `previews` avvia il processo alla prima richiesta, su una porta dinamica e su una
  copia privata dell'artefatto, mostra "Anteprima in avvio…" finché non risponde, lo riavvia
  quando `preview.json` indica un commit nuovo e lo spegne dopo 15 minuti senza richieste o
  quando gli artefatti spariscono (alla chiusura il worker chiede al builder di eliminarli).

### 8.4 Release (FR-50 … FR-59)

Eseguita dal `worker` con un advisory lock globale, così c'è una sola release alla volta:

Parte subito dopo il clic su **"Approva e pubblica"** (FR-51).

1. Verifica che chi approva abbia `CAP_RELEASE_APPROVE`. Se l'amministratore ha attivato la
   separazione dei compiti (FR-52, disattivata di default), verifica anche che non sia l'autore.
2. Rebase di `cs/<id>` su `main`. Se `main` è cambiato dall'ultima verifica, **i controlli
   vengono rieseguiti** e la release attende.
3. Build dell'artefatto finale in `releases/<release_id>/`.
4. `pg_dump` delle tabelle toccate dalle migrazioni, salvato in `backups/` (FR-56).
5. Applicazione delle migrazioni a `app_prod` **in una transazione**.
6. Avvio del colore inattivo (`green` se attivo è `blue`) sul nuovo artefatto.
7. Health check sul colore nuovo, poi Caddy sposta il traffico. Il vecchio colore resta
   in esecuzione per il rollback immediato.
8. Merge fast-forward su `main`, tag `release-<n>`, stato `released`, audit.

In caso di errore a un passo qualsiasi: transazione annullata, traffico sul colore
precedente, stato `release_failed` (NFR-05).

**Regola sulle migrazioni: prima si aggiunge, poi si toglie.** In una release si
aggiungono colonne e tabelle; le rimozioni vanno in una release successiva, quando il
codice non le usa più. Così il rollback del codice (FR-57) non richiede mai di ripristinare
il DB. Le migrazioni distruttive restano possibili, con conferma esplicita e backup obbligatorio.

### 8.5 Sincronizzazione produzione → staging

Job `staging.sync` (richiede `CAP_STAGING_SYNC`, su richiesta o pianificato):

1. copia i contenuti pubblicati di prod in `content_versions` con `env='staging'`;
2. copia gli asset dal bucket `prod` al bucket `staging`;
3. copia i dati applicativi, anonimizzando le colonne marcate `pii` nello schema delle
   collezioni (vedi domanda aperta PRD §10.2);
4. ricrea `app_staging`. I DB dei changeset aperti non vengono toccati.

---

## 9. Pubblicazione dei contenuti

- Contenuti statici: una nuova versione diventa visibile aggiornando `publications`.
- `cms-api` chiama `POST /__cms/revalidate` sul sito (token condiviso, solo rete interna)
  con i percorsi da rigenerare. Il sito usa `revalidatePath` di Next.js (NFR-03).
- Le pubblicazioni programmate sono job della coda con `run_at` al momento indicato.
- L'HTML libero dei blocchi viene sanitizzato al salvataggio con un'allowlist di tag e
  attributi. `<script>` e gli attributi `on*` non sono mai ammessi nei contenuti (FR-112).
  Le funzionalità interattive si fanno con componenti che passano dalla release.
- Header di sicurezza del sito: CSP con nonce, `X-Content-Type-Options`, `Referrer-Policy`.

---

## 10. Interfaccia: il widget in pagina

Non esiste un pannello di amministrazione separato (PRD §5.11). Si gestisce tutto
**dal sito stesso**, tramite un widget che compare su ogni pagina quando si è autenticati.

### 10.1 Caricamento

- Caddy instrada `/_cms/*` di **ogni host del sito** (`www.localhost`, `staging.localhost`,
  anteprime) verso `cms-api`. Widget, API e sito sono quindi sulla **stessa origine**:
  niente CORS, cookie condivisi.
- Il layout radice del sito (in `site-kit`) include un **loader inline di poche centinaia di
  byte**: se esiste il cookie `cms_ui=1` carica `/_cms/widget.js`, altrimenti non fa nulla.
  - `cms_ui` è solo un segnale, senza valore di sicurezza. La sessione vera è nel cookie
    `HttpOnly` `cms_session`, verificato da `cms-api` a ogni chiamata.
  - I visitatori non scaricano il widget e le pagine restano identiche per tutti, quindi
    **la cache ISR non si rompe**.
- `/_cms/login` è l'unica pagina non appartenente al sito: un form minimale di accesso.
  Dopo il login si torna alla pagina di partenza, già con il widget.
- Passaggio tra produzione e staging dal widget: `cms-api` genera un token monouso e
  reindirizza a `staging.localhost/_cms/sso?t=…`, che imposta la sessione su quell'host.

### 10.2 Isolamento

- `<cms-widget>` è un **custom element con Shadow DOM**: gli stili del sito non toccano il
  widget e gli stili del widget non toccano il sito.
- Il widget non modifica il DOM della pagina, tranne che per l'anteprima delle modifiche (10.4)
  e per l'evidenziazione degli elementi selezionati (overlay posizionati sopra la pagina).
- Posizione, dimensione e stato (aperto/chiuso) sono salvati in `localStorage`.
- Il widget stesso rispetta WCAG 2.1 AA: navigazione da tastiera, focus gestito, scorciatoia
  per aprirlo (`Ctrl/Cmd + .`).

### 10.3 Contenuto del widget

Il widget chiede a `cms-api` il **contesto della pagina** (`GET /_cms/api/context?path=…`):
nodo corrente, permessi effettivi dell'utente su quel nodo, capability, ambiente. Le schede
visibili dipendono da questi permessi: chi non ha un permesso non vede la scheda.

| Scheda | Contenuto | Visibile con |
|---|---|---|
| **Chat** | La conversazione con l'agente, che conosce la pagina corrente | sempre |
| **Pagina** | Titolo, head (meta, social), stato, versioni, pubblica, "Perché?" sui permessi | `r` sul nodo |
| **Sito** | Albero delle pagine, menu, layout (header/footer), impostazioni del sito | `l` su `/site` |
| **Sviluppo** | Changeset aperti, controlli, anteprime, "Approva e pubblica" | ambiente staging o `CAP_RELEASE_APPROVE` |
| **Utenti e permessi** | Utenti, gruppi, ACL del nodo corrente | `CAP_USER_ADMIN` / `CAP_GROUP_ADMIN` / `m` |
| **AI** | Connessioni, ruoli, consumi | `CAP_AGENT_CONFIG` |
| **Audit** | Registro filtrato | `CAP_AUDIT_READ` |

Tutto quello che si fa dalle schede si può fare anche dalla chat: le schede sono una
scorciatoia, non un secondo sistema. Entrambe chiamano le stesse API e gli stessi strumenti.

### 10.4 Chat contestuale e anteprima in pagina

- **Selezione di un elemento.** Il renderer aggiunge agli elementi dei blocchi gli attributi
  `data-cms-node` e `data-cms-block`. Con la modalità "seleziona" l'utente clicca un elemento
  della pagina e la chat riceve il riferimento esatto ("questo titolo", "questa immagine").
- **Anteprima sul posto.** Quando l'agente propone un piano, il widget chiede a `cms-api` il
  rendering in bozza (Next.js Draft Mode) e sostituisce temporaneamente il contenuto di
  `<main>` con l'anteprima, evidenziando le differenze. "Conferma" salva ed esegue il piano,
  "Annulla" ripristina la pagina.
- **Streaming.** La chat usa `POST /_cms/api/chat` con risposta in Server-Sent Events.
- **Sicurezza.** Tutte le chiamate modificanti richiedono il token CSRF ricevuto con il contesto.

### 10.5 Primo avvio: la pagina bianca

Il seed (§14.2) crea solo:

- il nodo `/site/pages/index` (la home, `/`) con **zero blocchi**;
- il layout radice minimo, che produce un documento HTML5 valido e vuoto:

```html
<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Nuovo sito</title>
  </head>
  <body>
    <main></main>
  </body>
</html>
```

Nessun tema, header, footer o menu predefinito: il visitatore vede una pagina bianca.
Root entra da `/_cms/login` e costruisce il sito dalla chat, a partire da quella pagina.

---

## 11. Regole HTML (`packages/html-rules`)

Ogni pagina prodotta dal CMS deve essere HTML corretto e semantico (PRD §5.12). Le regole
sono **una sola libreria** usata in tre punti:

1. **dagli strumenti dell'agente**: `create_page` e `update_blocks` renderizzano la bozza,
   la validano e restituiscono le violazioni all'agente, che le corregge prima di proporre
   il piano all'utente;
2. **alla pubblicazione**: una pagina con errori bloccanti non si può pubblicare;
3. **nella pipeline** (controllo `html`, §8.2): tutte le pagine del changeset, incluse quelle
   dinamiche renderizzate con i dati di staging.

### 11.1 Regole

| Regola | Livello | Implementazione |
|---|---|---|
| Documento HTML5 valido (doctype, `lang`, `charset`, viewport) | errore | layout radice + `html-validate` |
| Esattamente un `<title>`, non vuoto, **unico nel sito** | errore | `html-validate` + controllo sul sito |
| Esattamente un `<main>` | errore | regola propria |
| Esattamente un `<h1>` nelle pagine con contenuto | errore | regola propria |
| Nessun salto di livello nei titoli (`h2` → `h4`) | errore | `heading-level` di `html-validate` |
| `id` univoci, nesting valido, niente elementi deprecati | errore | `html-validate` |
| Immagini con `alt` (vuoto solo se decorative) | errore | `wcag/h37` |
| Link e pulsanti con testo riconoscibile | errore | regole WCAG di `html-validate` |
| Campi dei form con etichetta | errore | regole WCAG di `html-validate` |
| Landmark coerenti: `header`, `nav`, `main`, `footer` usati una volta al livello di pagina | avviso | regola propria |
| `meta description` presente, 50–160 caratteri | avviso | regola propria |
| Titolo della pagina entro 60 caratteri | avviso | regola propria |
| Contrasto colori sufficiente | avviso | axe-core (solo in pipeline e anteprima) |

### 11.2 Head e metadati

- Ogni nodo pagina ha una sezione `meta`: `title`, `description`, `lang`, `canonical`,
  `robots`, `og:title`, `og:description`, `og:image`, dati strutturati JSON-LD opzionali.
- Le impostazioni del sito (`/site/settings`) forniscono i default: nome del sito, modello
  del titolo (`%s · Nome sito`), lingua, favicon, immagine social.
- Il sito genera il `<head>` con `generateMetadata` di Next.js; header e footer vengono dai
  nodi di `/site/layouts`.
- `sitemap.xml` e `robots.txt` sono generati automaticamente dall'albero (`app/sitemap.ts`,
  `app/robots.ts`), includendo solo le pagine pubblicate e indicizzabili.

### 11.3 Titoli nel modello a blocchi

- Il blocco `heading` ha un livello (`1`–`6`). Il renderer calcola la struttura della pagina
  (outline) a partire da layout e blocchi.
- L'agente riceve l'outline corrente nel contesto della pagina, così sa quale livello usare.
- Nell'HTML libero (FR-22) le stesse regole si applicano al risultato renderizzato.

---

## 12. Autenticazione

- Password con `argon2id` (parametri OWASP); lockout progressivo dopo tentativi falliti.
- Sessioni server-side in `sessions`, cookie `HttpOnly`, `Secure`, `SameSite=Lax`;
  rotazione dell'id al login e al cambio di privilegi.
- CSRF: token per le richieste che modificano dati.
- TOTP obbligatorio per chi possiede capability sensibili (`CAP_USER_ADMIN`,
  `CAP_RELEASE_*`, `CAP_SECRETS`) (FR-72).
- Al primo avvio viene creato `root` con una password casuale stampata una sola volta
  nei log del container `cms-api`, da cambiare al primo accesso.

---

## 13. Segreti e credenziali

- Gestiti con i Docker secrets (`/run/secrets/*`), mai nelle immagini.
- Ogni servizio riceve solo i segreti di cui ha bisogno:

| Segreto | cms-api | worker | agent-runner | builder | site-prod | site-staging |
|---|---|---|---|---|---|---|
| `ai_keys_master` (cifra le chiavi API in `/system/secrets/ai`) | ✓ | | | | | |
| `pg_core_*` | ✓ | ✓ | | | | |
| `pg_prod_migrator` | | ✓ | | | | |
| `pg_prod_app` | | | | | ✓ | |
| `pg_staging_*` | ✓ | ✓ | | | | ✓ |
| `s3_access_key`, `s3_secret_key` | ✓ | ✓ | | | ✓ | |
| `revalidate_token` | ✓ | ✓ | | | ✓ | ✓ |
| `builder_token` (API interna del builder) | | ✓ | | ✓ | | |

- `builder` e `previews` eseguono codice del sito scritto dall'AI: non ricevono segreti della
  piattaforma. Il builder riceve solo il proprio `builder_token`; per ogni run il worker gli
  passa l'URL del DB del changeset con il ruolo `site_app`, che il builder scrive anche in
  `preview.json` per `previews`. Le credenziali `app_owner` restano nel worker, che applica
  le migrazioni.

- I segreti applicativi del sito (es. chiave di un servizio esterno) sono nodi in
  `/system/secrets`, cifrati nel DB, iniettati a runtime nel sito tramite `@site/config`.
  Gli agenti non possono leggerli (I4).
- I profili di login delle CLI in abbonamento stanno nel volume `cli-auth`, gestiti dalle
  CLI stesse; il CMS non li legge.

---

## 14. Ambiente locale

### 14.1 Avvio

```bash
cp .env.example .env
docker compose -f docker/compose.yml up -d
docker compose logs cms-api | grep "root password"
# poi: aprire http://www.localhost/_cms/login, entrare come root e collegare
# dal widget una chiave API, oppure un abbonamento con
docker compose exec -it agent-runner cms-connect claude-code --user root
```

| URL | Servizio |
|---|---|
| http://www.localhost | Sito di produzione (all'inizio una pagina bianca) |
| http://www.localhost/_cms/login | Accesso: dopo il login ogni pagina mostra il widget |
| http://staging.localhost | Sito di staging |
| http://cs-&lt;id&gt;.localhost | Anteprima di un changeset |
| http://mail.localhost | Mailpit |
| http://s3.localhost | API S3 (SeaweedFS) |

### 14.2 Primo avvio (seed)

1. Migrazioni di `cms_core`, poi creazione di utenti di sistema (`root` uid 0, `system`),
   gruppi predefiniti (PRD §5.7.8), capability e albero base con permessi di partenza.
   La home è una **pagina bianca** (§10.5).
2. Inizializzazione di `site.git` da `templates/site`, con i rami `main` e `staging`.
3. Primo build e prima release automatica (`release-0`), così la produzione parte subito.

### 14.3 Sviluppo della piattaforma

- `pnpm dev` avvia cms-api, widget e worker in locale con hot reload, collegati ai servizi Docker
  (Postgres, S3, git).
- `pnpm test` esegue tutti i test; `pnpm test:authz` solo i test del motore permessi.

---

## 15. Strategia di test

| Area | Tipo di test |
|---|---|
| `authz` | **Test tabellari** che riproducono la semantica POSIX (owner con meno permessi di other, maschera, named user, deny). **Property test** con fast-check: root soggetto agli invarianti, `x` mancante su un antenato nega sempre, un deny vince sempre, agente ⊆ utente. **Test differenziale opzionale**: gli stessi scenari rwx confrontati con un vero filesystem Linux (`setfacl`/`getfacl`) in un container. |
| `tree`, `content` | Integrazione su Postgres reale (testcontainers): transazioni, conflitti, ereditarietà. |
| Agenti | Strumenti testati in isolamento; scenari "red team" in cui l'agente riceve richieste fuori dai permessi e deve essere bloccato dal motore, non dal prompt. |
| Hook git | Push di file non autorizzati rifiutati. |
| Pipeline e release | End-to-end: changeset → controlli → approvazione → release → rollback, in Docker. |
| Criteri di accettazione PRD §9 | Una suite Playwright per criterio. |

---

## 16. Roadmap tecnica

Il dettaglio di task e subtask dell'MVP 1 è in `MVP1.md`.

| Milestone | Contenuto | Criteri PRD §9 |
|---|---|---|
| **M0 — Fondamenta** | Monorepo, Docker Compose, `cms_core`, auth, seed, audit | 1 |
| **M1 — Permessi** | `authz` completo, servizio `tree`, UI tipo `ls -l`/`getfacl`, "Perché?", test | 7, 8 |
| **M2 — Contenuti e widget** | Modello a blocchi, versioni, pubblicazione, sito con catch-all, revalidazione, home bianca, regole HTML, login e widget (chat e scheda Pagina) | 1, 11, 12 |
| **M3 — Provider e agente contenuti** | `packages/ai` (Claude Code, Anthropic, openai-compatible), gateway, server MCP, chat, strumenti, piani transazionali, conflitti | 2, 3 |
| **M4 — Staging e agente sviluppatore** | git + hook, agent-runner, changeset, DB e anteprime per changeset, controlli | 4 |
| **M5 — Release** | Revisione, approvazione, blue/green, backup, rollback | 5, 6 |
| **M6 — Rifinitura** | Sync prod → staging, "Chi può?", token API, TOTP, verifica audit, altri provider e CLI, riserve, consumi | 9, 10 |

---

## 17. Rischi e decisioni aperte

| Rischio / decisione | Mitigazione / proposta |
|---|---|
| Il codice generato introduce vulnerabilità che i controlli non vedono | Revisione umana obbligatoria, runtime in sola lettura con uscita di rete limitata, regole ESLint dedicate, revisore AI. |
| Allineamento tra albero dei nodi e file git | Manifest come fonte di verità, controllo `permissions` nella pipeline, job di riconciliazione. |
| Costo delle chiamate AI | Abbonamenti a prezzo fisso per l'uso interattivo, limiti di spesa per le chiavi API, modelli locali per i compiti semplici. |
| Termini d'uso degli abbonamenti | Solo CLI ufficiali non modificate, login personale per utente, niente condivisione, niente lavori in background sugli abbonamenti (§7.4). Verificare i termini di ogni provider prima di abilitarne la CLI. |
| Le CLI cambiano formato di output o opzioni | Adattatori CLI isolati e versioni delle CLI fissate nell'immagine, con test di integrazione a ogni aggiornamento. |
| Qualità diversa tra modelli | Lo stesso codice passa sempre dagli stessi controlli (§8.2); il ruolo indica le capacità minime richieste. |
| Build lente in locale | Cache di Turborepo e della build di Next.js condivise tra changeset. |
| `egress-proxy` e registry npm | Mirror locale opzionale (Verdaccio) per build riproducibili offline. |
| Passaggio futuro al cloud | I servizi sono già separati per rete e segreti: la migrazione a Kubernetes o a servizi gestiti cambia l'infrastruttura, non l'architettura. |
