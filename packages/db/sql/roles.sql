-- Group roles used by migrations for privileges. Idempotent; run as a superuser
-- (docker init script, test setup) before migrations. Login roles are members of these.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cms_rw') THEN
    CREATE ROLE cms_rw NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cms_content_ro') THEN
    CREATE ROLE cms_content_ro NOLOGIN;
  END IF;
END
$$;
