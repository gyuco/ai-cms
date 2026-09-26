CREATE TABLE "changesets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"branch" text NOT NULL,
	"base_commit" text NOT NULL,
	"head_commit" text,
	"author_uid" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"touched_paths" "ltree"[] DEFAULT '{}' NOT NULL,
	"destructive_migration" boolean DEFAULT false NOT NULL,
	"conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "changesets_branch_unique" UNIQUE("branch"),
	CONSTRAINT "changesets_status_check" CHECK ("changesets"."status" IN ('draft', 'checking', 'checks_failed', 'ready', 'releasing', 'released', 'release_failed', 'rejected', 'rolled_back', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "check_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"changeset_id" uuid NOT NULL,
	"commit" text NOT NULL,
	"check_name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"output" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "check_runs_status_check" CHECK ("check_runs"."status" IN ('queued', 'running', 'passed', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer NOT NULL,
	"changeset_ids" uuid[] NOT NULL,
	"commit" text,
	"artifact_path" text,
	"backup_path" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by" integer NOT NULL,
	"previous_release_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "releases_number_unique" UNIQUE("number"),
	CONSTRAINT "releases_status_check" CHECK ("releases"."status" IN ('pending', 'running', 'released', 'failed', 'rolled_back'))
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"changeset_id" uuid NOT NULL,
	"reviewer_uid" integer NOT NULL,
	"decision" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_decision_check" CHECK ("reviews"."decision" IN ('approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_author_uid_users_uid_fk" FOREIGN KEY ("author_uid") REFERENCES "public"."users"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_changeset_id_changesets_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."changesets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_approved_by_users_uid_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_changeset_id_changesets_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."changesets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_uid_users_uid_fk" FOREIGN KEY ("reviewer_uid") REFERENCES "public"."users"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "changesets_status_idx" ON "changesets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "check_runs_changeset_idx" ON "check_runs" USING btree ("changeset_id","commit");