CREATE TABLE "auth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"uid" integer NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "auth_tokens_purpose_check" CHECK ("auth_tokens"."purpose" IN ('invite', 'reset', 'sso'))
);
--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_uid_users_uid_fk" FOREIGN KEY ("uid") REFERENCES "public"."users"("uid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_tokens_uid_idx" ON "auth_tokens" USING btree ("uid");