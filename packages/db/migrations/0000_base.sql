-- Runtime roles (cms_rw) get DML on every table created by the schema owner.
-- Exceptions (e.g. the append-only audit log) revoke privileges explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cms_rw;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO cms_rw;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO cms_rw, cms_content_ro;
