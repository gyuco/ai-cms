# AI-CMS

Un CMS in cui pagine, dati e codice si creano e si modificano parlando con un'AI,
direttamente dalle pagine del sito.

- Requisiti funzionali: [`PRD.md`](PRD.md)
- Architettura: [`TECHNICAL.md`](TECHNICAL.md)
- Piano di lavoro dell'MVP 1: [`MVP1.md`](MVP1.md) e le [issue su GitHub](https://github.com/gyuco/ai-cms/issues)

## Requisiti

- Node.js 22 (vedi `.nvmrc`)
- pnpm 10 (`corepack enable`)
- Docker con Docker Compose

## Avvio in locale

```bash
make up      # genera i segreti locali, costruisce le immagini e avvia tutto
make ps      # stato dei servizi
make help    # tutti i comandi
make root-password   # password di root generata al primo avvio
```

Al primo avvio `cms-api` applica le migrazioni e crea l'utente `root` con una password
casuale, stampata una sola volta nei log e da cambiare al primo accesso.

| Indirizzo | Servizio |
|---|---|
| http://www.localhost | Sito di produzione (all'inizio una pagina bianca) |
| http://staging.localhost | Sito di staging |
| http://www.localhost/_cms/api/health | Backend del CMS |
| http://mail.localhost | Mailpit (email di sviluppo) |

- I segreti locali (password dei database, chiavi) sono generati in `docker/secrets/`, che
  non va mai committata.
- I servizi non raggiungono internet direttamente: l'uscita HTTPS passa da `egress-proxy`,
  che consente solo gli host elencati in `EGRESS_ALLOW` (vedi `docker/.env.example`).
- Dietro un proxy aziendale con ispezione TLS si può passare alla build un certificato CA
  aggiuntivo come secret BuildKit con id `extra_ca`.

## Sviluppo

```bash
pnpm install
pnpm build        # build di tutte le app
pnpm typecheck    # controllo dei tipi
pnpm lint         # ESLint
pnpm test         # Vitest
pnpm format       # Prettier
```

## Struttura

```
apps/
  cms-api/        backend del CMS (Next.js, servito su /_cms)
  worker/         job in background: controlli, build, release
packages/         librerie condivise (authz, db, tree, content, ai, widget, …)
templates/site/   scheletro del sito generato
docker/           ambiente locale (Docker Compose)
```

Il dettaglio di ogni pacchetto è in `TECHNICAL.md` §4.
