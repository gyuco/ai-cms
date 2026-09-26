import postgres from 'postgres';
import { ChangesetError } from './changesets.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** `app_cs_<id without dashes>`: the application database of a changeset (TECHNICAL §8.3). */
export function changesetDatabaseName(changesetId: string): string {
  if (!UUID.test(changesetId))
    throw new ChangesetError(`Id di changeset non valido: ${changesetId}`);
  return `app_cs_${changesetId.replace(/-/g, '')}`;
}

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new ChangesetError(`Nome di database non valido: ${name}`);
  return `"${name}"`;
}

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

export interface CreateChangesetDatabaseOptions {
  /** Database to clone; `app_staging` in production. */
  template?: string;
  /** Role granted CONNECT on the new database, if it exists; `site_app` by default. */
  appRole?: string;
  attempts?: number;
  retryDelayMs?: number;
}

/**
 * Clones the staging database for a changeset with `CREATE DATABASE … TEMPLATE`. `adminUrl`
 * is a connection of the role owning the template (app_owner, with CREATEDB) to another
 * database such as `postgres`. Idempotent: an existing database is kept.
 */
export async function createChangesetDatabase(
  adminUrl: string,
  changesetId: string,
  options: CreateChangesetDatabaseOptions = {},
): Promise<string> {
  const name = changesetDatabaseName(changesetId);
  const template = options.template ?? 'app_staging';
  const appRole = options.appRole ?? 'site_app';
  const attempts = options.attempts ?? 3;
  const statement = `CREATE DATABASE ${identifier(name)} TEMPLATE ${identifier(template)}`;
  identifier(appRole);

  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await sql.unsafe(statement);
        break;
      } catch (error) {
        if (errorCode(error) === '42P04') break; // already created by a previous attempt
        // 55006: the template still had open connections after the server waited ~5s.
        if (errorCode(error) !== '55006') throw error;
        if (attempt >= attempts) {
          throw new ChangesetError(
            `Impossibile creare il database del changeset: il database modello ${template} ` +
              `ha connessioni aperte. Riprova quando non è in uso.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 1_000));
      }
    }
    // Database-level privileges are not copied from the template.
    await sql.unsafe(`REVOKE ALL ON DATABASE ${identifier(name)} FROM PUBLIC`);
    const [role] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${appRole}`;
    if (role) await sql.unsafe(`GRANT CONNECT ON DATABASE ${identifier(name)} TO ${appRole}`);
    return name;
  } finally {
    await sql.end();
  }
}

/** Drops the changeset database, closing its remaining connections. Idempotent. */
export async function dropChangesetDatabase(adminUrl: string, changesetId: string): Promise<void> {
  const name = changesetDatabaseName(changesetId);
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${identifier(name)} WITH (FORCE)`);
  } finally {
    await sql.end();
  }
}
