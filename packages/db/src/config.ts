import { readFileSync } from 'node:fs';

export type CoreRole = 'owner' | 'api' | 'worker' | 'site_ro';

const loginRoles: Record<CoreRole, { user: string; secret: string }> = {
  owner: { user: 'cms_owner', secret: 'pg_core_owner' },
  api: { user: 'cms_api', secret: 'pg_core_api' },
  worker: { user: 'cms_worker', secret: 'pg_core_worker' },
  site_ro: { user: 'site_content_ro', secret: 'pg_core_site_ro' },
};

/** Reads a Docker secret, or the file named by the SECRETS_DIR env var in local development. */
export function readSecret(name: string): string {
  const dir = process.env.SECRETS_DIR ?? '/run/secrets';
  return readFileSync(`${dir}/${name}`, 'utf8').trim();
}

/**
 * Connection URL for cms_core with the given login role. `CORE_DATABASE_URL` overrides it
 * (local development and tests); otherwise it is built from CORE_DB_HOST and the role secret.
 */
export function coreDatabaseUrl(role: CoreRole): string {
  const override = process.env.CORE_DATABASE_URL;
  if (override) return override;
  const host = process.env.CORE_DB_HOST ?? 'localhost';
  const { user, secret } = loginRoles[role];
  const password = encodeURIComponent(readSecret(secret));
  return `postgres://${user}:${password}@${host}:5432/cms_core`;
}

export type AppEnv = 'prod' | 'staging';
export type AppRole = 'owner' | 'app';

const appLoginUsers: Record<AppRole, string> = { owner: 'app_owner', app: 'site_app' };

/**
 * Connection URL for an application database server (postgres-prod or postgres-staging),
 * built from PROD_DB_HOST / STAGING_DB_HOST and the `pg_<env>_<role>` secret. `database`
 * defaults to `app_<env>`.
 */
export function appDatabaseUrl(env: AppEnv, role: AppRole, database = `app_${env}`): string {
  const host = process.env[`${env.toUpperCase()}_DB_HOST`] ?? 'localhost';
  const password = encodeURIComponent(readSecret(`pg_${env}_${role}`));
  return `postgres://${appLoginUsers[role]}:${password}@${host}:5432/${database}`;
}
