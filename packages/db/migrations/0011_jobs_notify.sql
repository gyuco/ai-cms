-- One active job per dedupe key (e.g. a single pending check run per changeset).
CREATE UNIQUE INDEX jobs_dedupe_active_idx ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
--> statement-breakpoint
CREATE FUNCTION jobs_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('jobs', NEW.type);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER jobs_notify_insert
  AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_notify();
