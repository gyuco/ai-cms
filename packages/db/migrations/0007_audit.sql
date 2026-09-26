CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor_uid" integer NOT NULL,
	"agent" text,
	"action" text NOT NULL,
	"node_path" "ltree",
	"env" text,
	"outcome" text NOT NULL,
	"details" jsonb,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_uid","at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","at");--> statement-breakpoint
CREATE INDEX "audit_log_node_path_gist_idx" ON "audit_log" USING gist ("node_path");