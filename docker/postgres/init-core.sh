#!/bin/sh
# Platform database (cms_core) and its login roles.
set -eu
pw() { cat "/run/secrets/$1"; }

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE cms_owner LOGIN PASSWORD '$(pw pg_core_owner)';
CREATE ROLE cms_api LOGIN PASSWORD '$(pw pg_core_api)';
CREATE ROLE cms_worker LOGIN PASSWORD '$(pw pg_core_worker)';
CREATE ROLE site_content_ro LOGIN PASSWORD '$(pw pg_core_site_ro)';
GRANT cms_rw TO cms_api, cms_worker;
GRANT cms_content_ro TO site_content_ro;
CREATE DATABASE cms_core OWNER cms_owner;
REVOKE ALL ON DATABASE cms_core FROM PUBLIC;
GRANT CONNECT ON DATABASE cms_core TO cms_api, cms_worker, site_content_ro;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname cms_core <<SQL
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS citext;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO cms_owner;
SQL
