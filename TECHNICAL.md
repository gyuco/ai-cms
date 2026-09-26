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
   - *Repo piattaforma* (questo repository): console, motore permessi, agenti, pipeline.
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

---

## 2. Stack

| Area | Scelta | Motivo |
|---|---|---|
| Linguaggio | **TypeScript** (strict) su Node.js 22 LTS | Un linguaggio per tutto; `tsc` è il primo controllo sul codice generato. |
| Monorepo | pnpm workspaces + Turborepo | Pacchetti condivisi tra console, sito e worker. |
| Console (chat + admin) | Next.js (App Router) | UI e API della piattaforma. |
| Sito generato | Next.js (App Router) | Pagine statiche con ISR e pagine dinamiche nello stesso runtime. |
| Database | PostgreSQL 17 (con estensione `ltree`) | Albero dei nodi con query sugli antenati efficienti; `CREATE DATABASE … TEMPLATE` per clonare i DB di staging. |
| ORM e migrazioni | Drizzle ORM + drizzle-kit | Schema tipizzato, migrazioni SQL leggibili e revisionabili. |
| Code di lavoro | pg-boss (su PostgreSQL) | Nessun servizio in più da gestire. |
| Storage asset | MinIO (compatibile S3) | Bucket separati per produzione e staging. |
| Git server | Repository bare su volume + hook `pre-receive` | Semplice, locale, con controllo permessi anche lato git. |
| Reverse proxy | Caddy | Host `*.localhost`, routing verso anteprime dinamiche. |
| Email (locale) | Mailpit | Inviti e recupero password in sviluppo. |
| AI | Anthropic API: Claude Agent SDK (sviluppatore), Messages API con tool use (contenuti) | Modello configurabile per agente (FR-10). Default: `claude-opus-5-5` per l'agente sviluppatore, `claude-sonnet-5` per l'agente contenuti. |
| Validazione | Zod | Input degli strumenti AI, API, configurazioni. |
| Autenticazione | Modulo proprio: sessioni server-side, `argon2id`, TOTP (`otplib`) | Pochi requisiti, controllo totale, nessuna dipendenza esterna. |
| Test | Vitest, fast-check (property test), Playwright | Unit, motore permessi, end-to-end. |
| Sanitizzazione HTML | `sanitize-html` lato server | FR-112. |

---

## 3. Architettura dei container

```
                              ┌──────────────── caddy (:80) ────────────────┐
                              │ cms.localhost      → console                │
                              │ www.localhost      → site-prod (blue|green) │
                              │ staging.localhost  → site-staging           │
                              │ cs-<id>.localhost  → previews:<porta>       │
                              └──────┬───────────────┬───────────────┬──────┘
                                     │               │               │
  ┌──────────────────────── net: control ────────────┼───────────────┼─────────────┐
  │  console (Next.js)  ◄──►  postgres-core           │               │             │
  │      │   chat, admin,       db: cms_core           │               │             │
  │      │   API, authz         (utenti, albero, ACL,  │               │             │
  │      │                      contenuti, audit)      │               │             │
  │      ▼                                             │               │             │
  │  worker (pg-boss) ── builder ── git (bare repo) ───┼───────────────┤             │
  │      │                                             │               │             │
  │      └──► agent-runner (Claude Agent SDK, sandbox) │               │             │
  └───────────────────────────────────────────────────┼───────────────┼─────────────┘
                                                      │               │
  ┌────────────── net: prod ─────────────┐   ┌────────┴── net: staging ─────────────┐
  │ site-prod-blue / site-prod-green     │   │ site-staging, previews               │
  │ postgres-prod  (db: app_prod)        │   │ postgres-staging (app_staging,       │
  │ minio (bucket: prod)                 │   │   app_cs_<id>…)                      │
  └──────────────────────────────────────┘   │ minio (bucket: staging)              │
                                             └──────────────────────────────────────┘
  egress-proxy: unica uscita verso internet (api.anthropic.com, registry npm su autorizzazione)
```

### 3.1 Servizi

| Servizio | Ruolo | Reti | Note di sicurezza |
|---|---|---|---|
| `caddy` | Reverse proxy | tutte | Unico servizio esposto sull'host. |
| `console` | Chat, admin, API, motore permessi, agente contenuti | control, prod (solo contenuti), staging | Ha la chiave Anthropic. Non ha credenziali di scrittura sul codice di prod. |
| `worker` | Esegue i job: controlli, build, release, sincronizzazioni | control, prod, staging | Unico servizio con i ruoli DB di migrazione in prod. |
| `agent-runner` | Esegue l'agente sviluppatore in sandbox | control (solo API interna del worker), egress | **Nessun** accesso alle reti prod. Utente non root, filesystem limitato al workspace. |
| `builder` | Build di artefatti e test in un container usa e getta | staging | Nessuna credenziale di prod. |
| `git` | Repository bare del sito + hook | control | Hook `pre-receive` che verifica i permessi sui percorsi (difesa in profondità). |
| `postgres-core` | DB della piattaforma | control | Ruoli distinti per console, worker e audit. |
| `postgres-prod` | Dati applicativi di produzione | prod | Raggiungibile solo da `site-prod`, `console` (ruolo limitato) e `worker`. |
| `postgres-staging` | Dati applicativi di staging e di ogni changeset | staging | Un DB per changeset, clonato da template. |
| `site-prod-blue/green` | Runtime del sito pubblico | prod | Filesystem in sola lettura, utente non root, artefatto di release montato in sola lettura. |
| `site-staging` | Runtime staging (ramo `staging`) | staging | |
| `previews` | Anteprime dei changeset | staging | Un processo per changeset attivo, porte dinamiche. |
| `minio` | Asset | prod, staging | Bucket e credenziali separati per ambiente. |
| `egress-proxy` | Uscita verso internet con allowlist | egress | FR-111. |
| `mailpit` | SMTP locale | control | |

### 3.2 Volumi

| Volume | Contenuto |
|---|---|
| `pg-core`, `pg-prod`, `pg-staging` | Dati PostgreSQL |
| `git-repos` | Repository bare `site.git` |
| `workspaces` | Worktree git dei changeset (montato solo in `agent-runner` e `builder`) |
| `releases` | Artefatti di build: `releases/<release_id>/`, più i puntatori `blue` e `green` |
| `backups` | Dump pre-migrazione (FR-56) |
| `minio-data` | Asset |

---

## 4. Struttura del repository piattaforma

```
ai-cms/
├── apps/
│   ├── console/              Next.js: chat, admin, API REST interne
│   └── worker/               job pg-boss: pipeline, release, sync
├── packages/
│   ├── authz/                motore permessi (puro, senza I/O) + adattatore DB
│   ├── db/                   schema Drizzle di cms_core, migrazioni, seed
│   ├── tree/                 servizio nodi: CRUD sull'albero, sempre tramite authz
│   ├── content/              modello a blocchi, versioni, pubblicazione, sanitizzazione
│   ├── agents/
│   │   ├── content-agent/    strumenti e prompt dell'agente contenuti
│   │   └── dev-agent/        wrapper del Claude Agent SDK, hook sui permessi
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
│   └── images/               Dockerfile di console, worker, agent-runner, site-runtime
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

Il client DB di `site-kit` applica queste regole per le operazioni fatte dalla console.
Per le operazioni dei visitatori valgono le regole scritte nel codice del sito, verificate in revisione.

### 6.8 Applicazione dei permessi nel codice

- Tutti i servizi (`tree`, `content`, `pipeline`, …) ricevono un `RequestContext` con il
  `Principal`. Ogni metodo pubblico chiama `authz.require(...)` come prima istruzione.
- Una regola ESLint impedisce di importare `packages/db` fuori da `tree`, `content`,
  `pipeline`, `auth` e `audit`: le route e gli agenti non possono accedere al DB direttamente.
- Ogni decisione negativa e ogni decisione su azioni sensibili (`p`, `m`, `d`, capability)
  viene scritta nell'audit con la sua spiegazione.

---

## 7. Agenti AI

### 7.1 Agente contenuti (in `console`)

Usa la Messages API con tool use. Gli strumenti sono funzioni tipizzate con Zod;
ciascuna dichiara il permesso che richiede e passa da `tree` / `content`:

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

### 7.2 Agente sviluppatore (in `agent-runner`)

- Basato sul **Claude Agent SDK**. Il workspace è un `git worktree` del ramo `cs/<id>`.
- Gli strumenti predefiniti dell'SDK (lettura, scrittura, modifica file, shell) sono
  filtrati da un hook `PreToolUse` / `canUseTool`:
  - lettura e scrittura di file → percorso convertito in nodo, poi `authz.check`;
  - la shell accetta solo comandi in allowlist (`pnpm tsc`, `pnpm test`, `pnpm lint`,
    `pnpm drizzle-kit generate`, `git status`, `git diff`);
  - `pnpm add` richiede che l'utente abbia `CAP_DEPENDENCY_ADD` (FR-37), altrimenti
    l'agente produce una richiesta di approvazione.
- Strumenti aggiuntivi: `run_checks()`, `get_check_results()`, `query_staging_db(sql)`
  (sola lettura, sul DB del changeset), `open_preview()`.
- Il container non ha variabili d'ambiente di produzione, non vede le reti prod e
  raggiunge internet solo tramite `egress-proxy`.
- Al termine di ogni turno l'agente fa un commit sul ramo, con autore = utente e trailer
  `Agent: dev-agent` e `Conversation: <id>`.

### 7.3 Profili agente

Un profilo è una maschera di permessi per ambiente e percorso, salvata in
`/system/agents/<nome>` (modificabile con `CAP_AGENT_CONFIG`):

```jsonc
{
  "name": "content-agent",
  "model": "claude-sonnet-5",
  "envs": ["prod", "staging"],
  "allow": [{ "path": "site.**", "perms": "rlxwcdp", "storage": ["db", "s3"] }],
  "deny":  [{ "path": "system.**", "perms": "m" }],
  "budget": { "monthlyUsd": 50 }
}
```

I permessi dell'agente sono `permessi_utente ∩ profilo`, applicati al passo 2 dell'algoritmo.

---

## 8. Pipeline di sviluppo e release

### 8.1 Macchina a stati del changeset

```
draft ──► checking ──► checks_failed ──(agente corregge)──► checking
                  └──► ready ──► in_review ──► changes_requested ──► draft
                                          └──► approved ──► releasing ──► released
                                                                    └──► release_failed
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
| 6 | `migration` | Applicazione sul DB del changeset. Analisi dell'SQL: `DROP`, `RENAME`, `ALTER … TYPE` o `NOT NULL` senza default impostano `destructive_migration=true`, che richiede una seconda approvazione. |
| 7 | `build` | `next build`, che produce l'artefatto candidato. |
| 8 | `e2e` | Playwright sulle pagine toccate e sulle pagine critiche (home, 404). |
| 9 | `a11y` | axe-core sulle pagine toccate (NFR-07). |
| 10 | `ai-review` | Un secondo modello esamina il diff e segnala problemi (FR-43). È solo consultivo, non blocca. |

Se un controllo fallisce, il suo output viene passato all'agente sviluppatore, che può
riprovare fino a `maxAutoFixAttempts` volte (default 3) (FR-42).

### 8.3 DB e anteprima per ogni changeset

- `app_staging` è il database di staging, aggiornato con i contenuti e i dati di esempio.
- Per ogni changeset: `CREATE DATABASE app_cs_<id> TEMPLATE app_staging`. È una copia
  istantanea a livello di file e sostituisce il branching di Supabase.
- `previews` avvia `next start` sull'artefatto del changeset, collegato al suo DB, e Caddy
  lo espone su `cs-<id>.localhost`.
- Alla chiusura del changeset, DB e anteprima vengono eliminati.

### 8.4 Release (FR-50 … FR-59)

Eseguita dal `worker` con un advisory lock globale, così c'è una sola release alla volta:

1. Verifica che `approved_by` abbia `CAP_RELEASE_APPROVE` e sia diverso dall'autore (FR-52).
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
il DB. Le migrazioni distruttive restano possibili, ma con doppia approvazione e backup
obbligatorio.

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
- La console chiama `POST /__cms/revalidate` sul sito (token condiviso, solo rete interna)
  con i percorsi da rigenerare. Il sito usa `revalidatePath` di Next.js (NFR-03).
- Le pubblicazioni programmate sono gestite da un job pg-boss al momento indicato.
- L'HTML libero dei blocchi viene sanitizzato al salvataggio con un'allowlist di tag e
  attributi. `<script>` e gli attributi `on*` non sono mai ammessi nei contenuti (FR-112).
  Le funzionalità interattive si fanno con componenti che passano dalla release.
- Header di sicurezza del sito: CSP con nonce, `X-Content-Type-Options`, `Referrer-Policy`.

---

## 10. Autenticazione

- Password con `argon2id` (parametri OWASP); lockout progressivo dopo tentativi falliti.
- Sessioni server-side in `sessions`, cookie `HttpOnly`, `Secure`, `SameSite=Lax`;
  rotazione dell'id al login e al cambio di privilegi.
- CSRF: token per le richieste che modificano dati.
- TOTP obbligatorio per chi possiede capability sensibili (`CAP_USER_ADMIN`,
  `CAP_RELEASE_*`, `CAP_SECRETS`) (FR-72).
- Al primo avvio viene creato `root` con una password casuale stampata una sola volta
  nei log del container `console`, da cambiare al primo accesso.

---

## 11. Segreti e credenziali

- Gestiti con i Docker secrets (`/run/secrets/*`), mai nelle immagini.
- Ogni servizio riceve solo i segreti di cui ha bisogno:

| Segreto | console | worker | agent-runner | site-prod | site-staging |
|---|---|---|---|---|---|
| `anthropic_api_key` | ✓ | | ✓ | | |
| `pg_core_*` | ✓ | ✓ | | | |
| `pg_prod_migrator` | | ✓ | | | |
| `pg_prod_app` | | | | ✓ | |
| `pg_staging_*` | ✓ | ✓ | | | ✓ |
| `minio_prod` | ✓ | ✓ | | ✓ | |
| `revalidate_token` | ✓ | ✓ | | ✓ | ✓ |

- I segreti applicativi del sito (es. chiave di un servizio esterno) sono nodi in
  `/system/secrets`, cifrati nel DB, iniettati a runtime nel sito tramite `@site/config`.
  Gli agenti non possono leggerli (I4).

---

## 12. Ambiente locale

### 12.1 Avvio

```bash
cp .env.example .env              # inserire ANTHROPIC_API_KEY
docker compose -f docker/compose.yml up -d
docker compose logs console | grep "root password"
```

| URL | Servizio |
|---|---|
| http://cms.localhost | Console (chat e admin) |
| http://www.localhost | Sito di produzione |
| http://staging.localhost | Sito di staging |
| http://cs-&lt;id&gt;.localhost | Anteprima di un changeset |
| http://mail.localhost | Mailpit |
| http://minio.localhost | Console MinIO |

### 12.2 Primo avvio (seed)

1. Migrazioni di `cms_core`, poi creazione di utenti di sistema (`root` uid 0, `system`),
   gruppi predefiniti (PRD §5.7.8), capability e albero base con permessi di partenza.
2. Inizializzazione di `site.git` da `templates/site`, con i rami `main` e `staging`.
3. Primo build e prima release automatica (`release-0`), così la produzione parte subito.

### 12.3 Sviluppo della piattaforma

- `pnpm dev` avvia console e worker in locale con hot reload, collegati ai servizi Docker
  (Postgres, MinIO, git).
- `pnpm test` esegue tutti i test; `pnpm test:authz` solo i test del motore permessi.

---

## 13. Strategia di test

| Area | Tipo di test |
|---|---|
| `authz` | **Test tabellari** che riproducono la semantica POSIX (owner con meno permessi di other, maschera, named user, deny). **Property test** con fast-check: root soggetto agli invarianti, `x` mancante su un antenato nega sempre, un deny vince sempre, agente ⊆ utente. **Test differenziale opzionale**: gli stessi scenari rwx confrontati con un vero filesystem Linux (`setfacl`/`getfacl`) in un container. |
| `tree`, `content` | Integrazione su Postgres reale (testcontainers): transazioni, conflitti, ereditarietà. |
| Agenti | Strumenti testati in isolamento; scenari "red team" in cui l'agente riceve richieste fuori dai permessi e deve essere bloccato dal motore, non dal prompt. |
| Hook git | Push di file non autorizzati rifiutati. |
| Pipeline e release | End-to-end: changeset → controlli → approvazione → release → rollback, in Docker. |
| Criteri di accettazione PRD §9 | Una suite Playwright per criterio. |

---

## 14. Roadmap tecnica

| Milestone | Contenuto | Criteri PRD §9 |
|---|---|---|
| **M0 — Fondamenta** | Monorepo, Docker Compose, `cms_core`, auth, seed, audit | 1 |
| **M1 — Permessi** | `authz` completo, servizio `tree`, UI tipo `ls -l`/`getfacl`, "Perché?", test | 7, 8 |
| **M2 — Contenuti** | Modello a blocchi, versioni, pubblicazione, sito con catch-all, revalidazione | — |
| **M3 — Agente contenuti** | Chat, strumenti, piani transazionali, conflitti | 2, 3 |
| **M4 — Staging e agente sviluppatore** | git + hook, agent-runner, changeset, DB e anteprime per changeset, controlli | 4 |
| **M5 — Release** | Revisione, approvazione, blue/green, backup, rollback | 5, 6 |
| **M6 — Rifinitura** | Sync prod → staging, "Chi può?", token API, TOTP, verifica audit | 9 |

---

## 15. Rischi e decisioni aperte

| Rischio / decisione | Mitigazione / proposta |
|---|---|
| Il codice generato introduce vulnerabilità che i controlli non vedono | Revisione umana obbligatoria, runtime in sola lettura con uscita di rete limitata, regole ESLint dedicate, revisore AI. |
| Allineamento tra albero dei nodi e file git | Manifest come fonte di verità, controllo `permissions` nella pipeline, job di riconciliazione. |
| Costo delle chiamate AI | Budget per profilo agente, prompt caching, modello più leggero per l'agente contenuti. |
| Build lente in locale | Cache di Turborepo e della build di Next.js condivise tra changeset. |
| `egress-proxy` e registry npm | Mirror locale opzionale (Verdaccio) per build riproducibili offline. |
| Passaggio futuro al cloud | I servizi sono già separati per rete e segreti: la migrazione a Kubernetes o a servizi gestiti cambia l'infrastruttura, non l'architettura. |
