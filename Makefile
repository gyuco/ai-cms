COMPOSE := docker compose --project-directory docker -f docker/compose.yml

.PHONY: help secrets up down reset logs ps seed root-password reset-root-password connect-claude-code

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

seed: ## Riesegue migrazioni e seed (avvengono a ogni avvio di cms-api)
	$(COMPOSE) restart cms-api

shell-%: ## Apre una shell in un servizio (es. make shell-cms-api)
	$(COMPOSE) exec $* sh

root-password: ## Mostra la password di root generata al primo avvio
	@$(COMPOSE) logs cms-api | grep 'root password' || echo "Non trovata: la password è stampata solo al primo avvio. Usa make reset-root-password."

reset-root-password: ## Genera una nuova password temporanea per root
	$(COMPOSE) exec cms-api node apps/cms-api/admin.mjs reset-root-password

connect-claude-code: ## Collega il tuo abbonamento Claude Code (make connect-claude-code user=<username>)
	@[ -n "$(user)" ] || { echo "Uso: make connect-claude-code user=<username>"; exit 1; }
	$(COMPOSE) exec -it agent-runner cms-connect claude-code --user "$(user)"
