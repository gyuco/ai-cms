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
