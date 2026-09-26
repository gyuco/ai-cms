CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"path" "ltree" NOT NULL,
	"kind" text NOT NULL,
	"storage" text DEFAULT 'db' NOT NULL,
	"env" text DEFAULT 'both' NOT NULL,
	"created_by" integer NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "nodes_name_check" CHECK (("nodes"."parent_id" IS NULL AND "nodes"."name" = '') OR "nodes"."name" ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
	CONSTRAINT "nodes_kind_check" CHECK ("nodes"."kind" IN ('dir', 'page', 'layout', 'menu', 'asset', 'collection', 'file', 'setting', 'secret', 'agent')),
	CONSTRAINT "nodes_storage_check" CHECK ("nodes"."storage" IN ('db', 'git', 's3', 'virtual')),
	CONSTRAINT "nodes_env_check" CHECK ("nodes"."env" IN ('prod', 'staging', 'both'))
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_created_by_users_uid_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_path_live_idx" ON "nodes" USING btree ("path") WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_parent_name_live_idx" ON "nodes" USING btree ("parent_id","name") WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_path_gist_idx" ON "nodes" USING gist ("path");--> statement-breakpoint
CREATE INDEX "nodes_parent_idx" ON "nodes" USING btree ("parent_id");