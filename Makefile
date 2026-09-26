COMPOSE := docker compose --project-directory docker -f docker/compose.yml

.PHONY: help secrets up down reset logs ps seed

help: ## Mostra i comandi disponibili
	@grep -E '^[a-zA-Z_%-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'

secrets: ## Genera i segreti locali mancanti (docker/secrets)
	@./docker/scripts/init-secrets.sh

up: secrets ## Costruisce e avvia tutti i servizi
	$(COMPOSE) up -d --build

down: ## Ferma i servizi (i dati restano)
	$(COMPOSE) down

reset: ## Ferma i servizi e CANCELLA tutti i dati, dopo conferma
	@printf "Tutti i dati locali (database, asset, repository) verranno cancellati. Scrivi RESET per confermare: "; \
	read answer; [ "$$answer" = "RESET" ] || { echo "Annullato."; exit 1; }
	$(COMPOSE) down --volumes

logs: ## Segue i log di tutti i servizi (make logs s=cms-api per uno solo)
	$(COMPOSE) logs -f $(s)

ps: ## Stato dei servizi
	$(COMPOSE) ps

seed: ## Esegue le migrazioni e il seed iniziale
	$(COMPOSE) exec cms-api node apps/cms-api/seed.js

shell-%: ## Apre una shell in un servizio (es. make shell-cms-api)
	$(COMPOSE) exec $* sh
