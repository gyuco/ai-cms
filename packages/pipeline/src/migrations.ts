import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { runGit } from './git.ts';

/** Where the site keeps its SQL migrations (TECHNICAL §4.1). */
export const SITE_MIGRATIONS_DIR = 'db/migrations';

export interface SiteMigration {
  /** File name, e.g. `0001_prodotti.sql`; migrations are applied in name order. */
  name: string;
  sql: string;
  /** git blob id: tells whether a migration changed between two commits. */
  blob: string;
}

export interface DestructiveStatement {
  statement: string;
  /** Italian explanation of why the statement can lose data or break the running code. */
  reason: string;
}

/**
 * Normalizes SQL for analysis: drops comments, blanks out string literals and dollar-quoted
 * bodies, and splits it into statements. Each statement comes back twice: as written (with
 * comments removed and spaces collapsed) and as an uppercase "shape" whose quoted identifiers
 * cannot be mistaken for keywords.
 */
export function splitSqlStatements(sql: string): Array<{ text: string; shape: string }> {
  const statements: Array<{ text: string; shape: string }> = [];
  let text = '';
  let shape = '';
  const flush = () => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) statements.push({ text: t, shape: shape.replace(/\s+/g, ' ').trim() });
    text = '';
    shape = '';
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      text += ' ';
      shape += ' ';
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      text += ' ';
      shape += ' ';
    } else if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      text += sql.slice(i, j + 1);
      shape += "''";
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j++;
      }
      const name = sql.slice(i + 1, j);
      text += sql.slice(i, j + 1);
      shape += `"${name.toUpperCase().replace(/[^A-Z0-9_$]/g, '_')}"`;
      i = j + 1;
    } else if (c === '$' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (!tag) {
        text += c;
        shape += c;
        i++;
        continue;
      }
      const end = sql.indexOf(tag[0], i + tag[0].length);
      const stop = end === -1 ? sql.length : end + tag[0].length;
      text += sql.slice(i, stop);
      shape += '$$ $$';
      i = stop;
    } else if (c === ';') {
      flush();
      i++;
    } else {
      text += c;
      shape += c.toUpperCase();
      i++;
    }
  }
  flush();
  return statements;
}

/** Splits at top-level commas, outside parentheses. */
function topLevelParts(shape: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of shape) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += c;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const NAME = String.raw`(?:"[^"]*"|[\w$]+)(?:\.(?:"[^"]*"|[\w$]+))*`;
const ALTER_TABLE = new RegExp(
  String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${NAME})\s*\*? (.*)$`,
);
const DROP_OBJECT = /^DROP (TABLE|SCHEMA|TYPE|DOMAIN|SEQUENCE|MATERIALIZED VIEW|DATABASE|OWNED)\b/;

const dropReasons: Record<string, string> = {
  TABLE: 'elimina una tabella e i suoi dati',
  SCHEMA: 'elimina uno schema e tutto ciò che contiene',
  TYPE: 'elimina un tipo usato dalle colonne',
  DOMAIN: 'elimina un dominio usato dalle colonne',
  SEQUENCE: 'elimina una sequenza',
  'MATERIALIZED VIEW': 'elimina una vista materializzata',
  DATABASE: 'elimina un database',
  OWNED: 'elimina gli oggetti di un ruolo',
};

function alterTableReasons(actions: string): string[] {
  const reasons: string[] = [];
  const parts = topLevelParts(actions);
  const defaults = new Set(
    parts
      .map((p) => new RegExp(String.raw`^ALTER (?:COLUMN )?(${NAME}) SET DEFAULT\b`).exec(p)?.[1])
      .filter(Boolean),
  );
  for (const part of parts) {
    if (/^RENAME CONSTRAINT\b/.test(part)) continue;
    if (/^RENAME\b/.test(part)) {
      reasons.push(
        part.startsWith('RENAME TO')
          ? 'rinomina una tabella: il codice in produzione usa ancora il vecchio nome'
          : 'rinomina una colonna: il codice in produzione usa ancora il vecchio nome',
      );
      continue;
    }
    if (/^DROP\b/.test(part) && !/^DROP CONSTRAINT\b/.test(part)) {
      reasons.push('elimina una colonna e i suoi dati');
      continue;
    }
    const alter = new RegExp(String.raw`^ALTER (?:COLUMN )?(${NAME}) (.*)$`).exec(part);
    if (alter) {
      const [, column, rest] = alter;
      if (/^(?:SET DATA )?TYPE\b/.test(rest!)) {
        reasons.push('cambia il tipo di una colonna: la conversione può perdere dati o fallire');
      } else if (/^SET NOT NULL\b/.test(rest!) && !defaults.has(column)) {
        reasons.push(
          'rende obbligatoria una colonna senza un valore di default: fallisce sulle righe esistenti con valori nulli',
        );
      }
      continue;
    }
    const add = new RegExp(String.raw`^ADD (?:COLUMN )?(?:IF NOT EXISTS )?${NAME} (.*)$`).exec(
      part,
    );
    if (add && !/^(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/.test(part.slice(4))) {
      const definition = add[1]!;
      if (/\bNOT NULL\b/.test(definition) && !/\b(?:DEFAULT|GENERATED)\b/.test(definition)) {
        reasons.push(
          'aggiunge una colonna obbligatoria senza default: fallisce se la tabella contiene righe',
        );
      }
    }
  }
  return reasons;
}

/**
 * Statements that can lose data or break the code already running against the database
 * (TECHNICAL §8.2, §8.4 "prima si aggiunge, poi si toglie"): DROP of tables, columns and other
 * objects, TRUNCATE, RENAME, ALTER … TYPE, and NOT NULL without a default.
 */
export function findDestructiveStatements(sql: string): DestructiveStatement[] {
  const found: DestructiveStatement[] = [];
  for (const { text, shape } of splitSqlStatements(sql)) {
    const reasons: string[] = [];
    const drop = DROP_OBJECT.exec(shape);
    if (drop) reasons.push(dropReasons[drop[1]!]!);
    if (/^TRUNCATE\b/.test(shape)) reasons.push('svuota una tabella');
    const alterTable = ALTER_TABLE.exec(shape);
    if (alterTable) {
      reasons.push(...alterTableReasons(alterTable[2]!));
    } else if (
      /^ALTER \w+(?: \w+)? .*\bRENAME\b/.test(shape) &&
      !/\bRENAME CONSTRAINT\b/.test(shape)
    ) {
      reasons.push(
        'rinomina un oggetto del database: il codice in produzione usa ancora il vecchio nome',
      );
    }
    for (const reason of new Set(reasons)) found.push({ statement: text, reason });
  }
  return found;
}

/** The `.sql` files under `db/migrations` at a commit of a repository, in name order. */
export async function readSiteMigrations(repo: string, commit: string): Promise<SiteMigration[]> {
  const listing = await runGit(['ls-tree', '-z', commit, '--', `${SITE_MIGRATIONS_DIR}/`], {
    cwd: repo,
  });
  const entries = listing
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t') as [string, string];
      const [, type, blob] = meta.split(' ') as [string, string, string];
      return { type, blob, name: path.slice(SITE_MIGRATIONS_DIR.length + 1) };
    })
    .filter((e) => e.type === 'blob' && /^[\w.-]+\.sql$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const migrations: SiteMigration[] = [];
  for (const entry of entries) {
    const sql = await runGit(['cat-file', 'blob', entry.blob], { cwd: repo });
    migrations.push({ name: entry.name, sql, blob: entry.blob });
  }
  return migrations;
}

export class MigrationError extends Error {
  constructor(
    readonly migration: string,
    message: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface ApplyMigrationsResult {
  applied: string[];
  alreadyApplied: string[];
  /**
   * The database has migrations that are no longer in the list, or that changed after being
   * applied: nothing was applied, the caller must recreate the database first.
   */
  needsReset: boolean;
}

export interface ApplyMigrationsOptions {
  /**
   * Applies every missing migration in one transaction: either all of them are recorded or
   * none (a release, TECHNICAL §8.4). By default each migration has its own transaction.
   */
  atomic?: boolean;
  /**
   * Migrations already present in the database when it is not tracked yet (a clone of a
   * database whose schema predates the tracking table): recorded without being run.
   */
  baseline?: readonly string[];
}

const hashOf = (sql: string) => createHash('sha256').update(sql).digest('hex');

/**
 * Applies the migrations missing from a site database, each in its own transaction, and
 * records them in `_cms.migrations` (a schema the site role cannot read or write).
 * `url` must use the role owning the schema (`app_owner`).
 */
export async function applySiteMigrations(
  url: string,
  migrations: readonly SiteMigration[],
  options: ApplyMigrationsOptions = {},
): Promise<ApplyMigrationsResult> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [{ tracked } = { tracked: false }] = await sql<Array<{ tracked: boolean }>>`
      SELECT to_regclass('_cms.migrations') IS NOT NULL AS tracked`;
    if (!tracked) {
      const baseline = migrations.filter((m) => options.baseline?.includes(m.name));
      await sql.begin(async (tx) => {
        await tx.unsafe(`
          CREATE SCHEMA IF NOT EXISTS _cms;
          CREATE TABLE IF NOT EXISTS _cms.migrations (
            name text PRIMARY KEY,
            hash text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now()
          );`);
        for (const m of baseline) {
          await tx`INSERT INTO _cms.migrations (name, hash) VALUES (${m.name}, ${hashOf(m.sql)})`;
        }
      });
    }
    const rows = await sql<Array<{ name: string; hash: string }>>`
      SELECT name, hash FROM _cms.migrations ORDER BY name`;
    const wanted = new Map(migrations.map((m) => [m.name, hashOf(m.sql)]));
    if (rows.some((row) => wanted.get(row.name) !== row.hash)) {
      return { applied: [], alreadyApplied: [], needsReset: true };
    }
    const done = new Set(rows.map((row) => row.name));
    const applied: string[] = [];
    const pending = migrations.filter((m) => !done.has(m.name));
    const run = async (tx: postgres.TransactionSql, migration: SiteMigration) => {
      try {
        await tx.unsafe(migration.sql);
        await tx`INSERT INTO _cms.migrations (name, hash) VALUES (${migration.name}, ${hashOf(migration.sql)})`;
      } catch (error) {
        throw new MigrationError(
          migration.name,
          `La migrazione ${migration.name} non si applica: ${(error as Error).message}`,
        );
      }
      applied.push(migration.name);
    };
    if (options.atomic) {
      try {
        await sql.begin(async (tx) => {
          for (const migration of pending) await run(tx, migration);
        });
      } catch (error) {
        applied.length = 0;
        throw error;
      }
    } else {
      for (const migration of pending) await sql.begin((tx) => run(tx, migration));
    }
    return { applied, alreadyApplied: [...done], needsReset: false };
  } finally {
    await sql.end();
  }
}

/**
 * The migrations a database has not applied yet (all of them when it does not track them).
 * `url` needs only read access to `_cms.migrations`; a migration changed after being applied
 * counts as pending, and applying it reports `needsReset`.
 */
export async function pendingSiteMigrations(
  url: string,
  migrations: readonly SiteMigration[],
): Promise<SiteMigration[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [{ tracked } = { tracked: false }] = await sql<Array<{ tracked: boolean }>>`
      SELECT to_regclass('_cms.migrations') IS NOT NULL AS tracked`;
    if (!tracked) return [...migrations];
    const rows = await sql<Array<{ name: string; hash: string }>>`
      SELECT name, hash FROM _cms.migrations`;
    const done = new Map(rows.map((row) => [row.name, row.hash]));
    return migrations.filter((m) => done.get(m.name) !== hashOf(m.sql));
  } finally {
    await sql.end();
  }
}

const TOUCHED_TABLE = new RegExp(
  String.raw`^(?:ALTER TABLE (?:IF EXISTS )?(?:ONLY )?|DROP TABLE (?:IF EXISTS )?|TRUNCATE (?:TABLE )?(?:ONLY )?|UPDATE (?:ONLY )?|DELETE FROM (?:ONLY )?|INSERT INTO |CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?\S+ ON (?:ONLY )?)(${NAME})`,
  'i',
);

/**
 * Tables an SQL script alters, drops, empties or writes to: the ones a release backs up with
 * `pg_dump` before applying the migrations (FR-56). New tables are not listed, since they
 * hold nothing to lose. Names come back without schema when they are in `public`.
 */
export function tablesTouchedBy(sql: string): string[] {
  const tables = new Set<string>();
  for (const { text } of splitSqlStatements(sql)) {
    const found = TOUCHED_TABLE.exec(text);
    if (!found) continue;
    const name = found[1]!
      .split('.')
      .map((part) =>
        part.startsWith('"') ? part.slice(1, -1).replace(/""/g, '"') : part.toLowerCase(),
      )
      .join('.');
    tables.add(name.startsWith('public.') ? name.slice('public.'.length) : name);
  }
  return [...tables].sort();
}
