# @ai-cms/pipeline

Coda dei job, repository del sito e ciclo di vita dei changeset (TECHNICAL §8).

## Repository del sito

- `site.git` è un repository bare in `<gitRoot>/site.git` (`GIT_ROOT`, default `/data/git`).
  Solo il `worker` ci scrive.
- `initSiteRepo` lo crea importando `templates/site` (senza `node_modules`, `.next`, `.turbo`,
  `tsconfig.tsbuildinfo`) come commit iniziale su `main`, crea `staging` dallo stesso commit e
  installa l'hook `pre-receive`. È idempotente: il worker la esegue a ogni avvio (job
  `site.init`).
- L'hook (`src/pre-receive.ts`, copia in `docker/git/hooks/pre-receive`) accetta un push solo
  se `CMS_GIT_ACTOR` è `changeset` (rami `cs/*`) o `release` (`main`, `staging`, tag
  `release-*`).

## Changeset

- Ogni changeset ha un clone di lavoro in `<workspacesRoot>/<id>` (`WORKSPACES_ROOT`, default
  `/data/workspaces`) sul ramo `cs/<id>`, creato da `staging`. L'agente sviluppatore lavora e fa
  commit solo lì.
- `recordWork` spinge `cs/<id>` nel repository bare (`CMS_GIT_ACTOR=changeset`) e aggiorna
  `head_commit` e `touched_paths`.
- Ogni changeset ha il suo database `app_cs_<id>`, clonato da `app_staging`.

## Dipendenze `@ai-cms/*` del sito

Il modello del sito può dipendere da pacchetti del monorepo con `workspace:*`. Nel repository
del sito queste dipendenze non sono risolvibili da sole: il commit iniziale le lascia come sono
e la loro risoluzione è compito del builder (E11.2), che monta il monorepo durante install e
build.
