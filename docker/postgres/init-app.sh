#!/bin/sh
# Site application database (app_prod or app_staging) and its login roles.
# APP_DB and SECRET_PREFIX come from the service environment.
set -eu
pw() { cat "/run/secrets/$1"; }

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE app_owner LOGIN CREATEDB PASSWORD '$(pw "${SECRET_PREFIX}_owner")';
CREATE ROLE site_app LOGIN PASSWORD '$(pw "${SECRET_PREFIX}_app")';
CREATE DATABASE ${APP_DB} OWNER app_owner;
REVOKE ALL ON DATABASE ${APP_DB} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${APP_DB} TO site_app;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${APP_DB}" <<SQL
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO app_owner;
GRANT USAGE ON SCHEMA public TO site_app;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO site_app;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO site_app;
SQL
