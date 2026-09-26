import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read-only connection for site builds and previews to the published content
 * (role site_content_ro, which can only read the published_content view: public data).
 * CONTENT_DATABASE_URL wins; otherwise CORE_DB_HOST plus the `pg_core_site_ro` secret.
 * Returns undefined when neither is configured.
 */
export function contentDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CONTENT_DATABASE_URL) return env.CONTENT_DATABASE_URL;
  if (!env.CORE_DB_HOST) return undefined;
  try {
    const secret = readFileSync(join(env.SECRETS_DIR ?? '/run/secrets', 'pg_core_site_ro'), 'utf8');
    const password = encodeURIComponent(secret.trim());
    return `postgres://site_content_ro:${password}@${env.CORE_DB_HOST}:5432/cms_core`;
  } catch {
    return undefined;
  }
}
