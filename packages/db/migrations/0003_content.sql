CREATE TABLE "content_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"env" text NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"author_uid" integer NOT NULL,
	"via_agent" text,
	"conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_versions_node_env_version_key" UNIQUE("node_id","env","version"),
	CONSTRAINT "content_versions_env_check" CHECK ("content_versions"."env" IN ('prod', 'staging'))
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"node_id" uuid NOT NULL,
	"env" text NOT NULL,
	"version_id" bigint NOT NULL,
	"status" text NOT NULL,
	"publish_at" timestamp with time zone,
	"published_by" integer NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publications_node_id_env_pk" PRIMARY KEY("node_id","env"),
	CONSTRAINT "publications_env_check" CHECK ("publications"."env" IN ('prod', 'staging')),
	CONSTRAINT "publications_status_check" CHECK ("publications"."status" IN ('published', 'scheduled', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_author_uid_users_uid_fk" FOREIGN KEY ("author_uid") REFERENCES "public"."users"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_version_id_content_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."content_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_published_by_users_uid_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publications_scheduled_idx" ON "publications" USING btree ("publish_at") WHERE "publications"."status" = 'scheduled';