# CLAUDE.md

Guida per gli agenti che lavorano su questo repository.

## Documenti di riferimento

- `PRD.md`: requisiti funzionali (`FR-xx`)
- `TECHNICAL.md`: architettura
- `MVP1.md`: task dell'MVP 1; ogni task ha una issue su GitHub (titolo con l'ID, es. `[E4.2]`)

## Comandi

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm format
```

Prima di ogni commit devono passare `format:check`, `lint`, `typecheck` e `test`.

## Convenzioni

- TypeScript strict ovunque. I pacchetti interni (`@ai-cms/*`) esportano sorgenti TypeScript
  da `src/index.ts`; non hanno un passo di build proprio.
- Moduli ESM (`"type": "module"`).
- Test accanto al codice: `src/**/*.test.ts`.
- Testi rivolti agli utenti in italiano; codice, identificatori e commenti in inglese.
- Ogni azione su nodi e contenuti passa da `@ai-cms/authz` (TECHNICAL §6). `@ai-cms/db` si può
  importare solo da `db`, `tree`, `content`, `pipeline`, `auth`, `audit`, `ai-config`,
  `apps/cms-api/lib`, `apps/cms-api/cli`, `apps/worker` e dai test (regola ESLint
  `no-restricted-imports`).
- In fase 1 tutti gli utenti sono amministratori, ma i vincoli di sistema (TECHNICAL §6.3)
  valgono sempre.
- Commit piccoli, uno per task quando possibile, con `Closes #<issue>` quando la task è completa.
