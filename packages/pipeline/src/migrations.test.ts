import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabaseUrl } from '@ai-cms/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGit } from './git.ts';
import {
  applySiteMigrations,
  findDestructiveStatements,
  MigrationError,
  pendingSiteMigrations,
  readSiteMigrations,
  splitSqlStatements,
  tablesTouchedBy,
} from './migrations.ts';

const reasons = (sql: string) => findDestructiveStatements(sql).map((f) => f.reason);

describe('splitSqlStatements', () => {
  it('ignores comments, strings and dollar-quoted bodies', () => {
    const statements = splitSqlStatements(`
      -- DROP TABLE commented;
      /* DROP TABLE block; */
      INSERT INTO note (testo) VALUES ('DROP TABLE x; ancora'), (E'it\\'s; ok');
      --> statement-breakpoint
      CREATE FUNCTION f() RETURNS void AS $body$ BEGIN DROP TABLE y; END $body$ LANGUAGE plpgsql;
      CREATE TABLE "drop table" (id int)`);
    expect(statements.map((s) => s.shape)).toEqual([
      "INSERT INTO NOTE (TESTO) VALUES (''), (E'')",
      'CREATE FUNCTION F() RETURNS VOID AS $$ $$ LANGUAGE PLPGSQL',
      'CREATE TABLE "DROP_TABLE" (ID INT)',
    ]);
    expect(statements[2]!.text).toBe('CREATE TABLE "drop table" (id int)');
  });
});

describe('findDestructiveStatements', () => {
  it('accepts additive migrations', () => {
    expect(
      findDestructiveStatements(`
        CREATE TABLE prodotti (id serial PRIMARY KEY, nome text NOT NULL);
        ALTER TABLE prodotti ADD COLUMN prezzo numeric;
        ALTER TABLE prodotti ADD COLUMN attivo boolean NOT NULL DEFAULT true;
        ALTER TABLE prodotti ADD CONSTRAINT prezzo_positivo CHECK (prezzo > 0);
        ALTER TABLE prodotti ALTER COLUMN prezzo SET DEFAULT 0;
        ALTER TABLE prodotti ALTER COLUMN prezzo DROP NOT NULL;
        ALTER TABLE prodotti DROP CONSTRAINT prezzo_positivo;
        CREATE INDEX prodotti_nome_idx ON prodotti (nome);
        DROP INDEX prodotti_nome_idx;
        INSERT INTO prodotti (nome) VALUES ('DROP TABLE prodotti');`),
    ).toEqual([]);
  });

  it('flags drops, truncates and renames', () => {
    expect(reasons('DROP TABLE IF EXISTS "public"."ordini" CASCADE')).toEqual([
      'elimina una tabella e i suoi dati',
    ]);
    expect(reasons('ALTER TABLE ordini DROP COLUMN note')).toEqual([
      'elimina una colonna e i suoi dati',
    ]);
    expect(reasons('alter table only ordini drop note')).toEqual([
      'elimina una colonna e i suoi dati',
    ]);
    expect(reasons('TRUNCATE ordini')).toEqual(['svuota una tabella']);
    expect(reasons('ALTER TABLE ordini RENAME COLUMN note TO commento')[0]).toMatch(
      /rinomina una colonna/,
    );
    expect(reasons('ALTER TABLE ordini RENAME TO acquisti')[0]).toMatch(/rinomina una tabella/);
    expect(reasons("ALTER TYPE stato RENAME VALUE 'a' TO 'b'")[0]).toMatch(/rinomina un oggetto/);
    expect(reasons('ALTER TABLE ordini RENAME CONSTRAINT a TO b')).toEqual([]);
  });

  it('flags type changes and NOT NULL without a default', () => {
    expect(reasons('ALTER TABLE ordini ALTER COLUMN totale TYPE integer')[0]).toMatch(
      /cambia il tipo/,
    );
    expect(
      reasons('ALTER TABLE ordini ALTER totale SET DATA TYPE bigint USING totale::bigint')[0],
    ).toMatch(/cambia il tipo/);
    expect(reasons('ALTER TABLE "ordini" ALTER COLUMN "note" SET NOT NULL')[0]).toMatch(
      /senza un valore di default/,
    );
    expect(
      reasons(
        "ALTER TABLE ordini ALTER COLUMN note SET DEFAULT '', ALTER COLUMN note SET NOT NULL",
      ),
    ).toEqual([]);
    expect(reasons('ALTER TABLE ordini ADD COLUMN codice text NOT NULL')[0]).toMatch(
      /obbligatoria senza default/,
    );
    expect(
      reasons('ALTER TABLE ordini ADD COLUMN anno int NOT NULL GENERATED ALWAYS AS (1) STORED'),
    ).toEqual([]);
  });

  it('reports each statement of a drizzle-kit migration', () => {
    const found = findDestructiveStatements(
      'ALTER TABLE "a" DROP COLUMN "x";--> statement-breakpoint\nDROP TABLE "b";',
    );
    expect(found.map((f) => f.statement)).toEqual([
      'ALTER TABLE "a" DROP COLUMN "x"',
      'DROP TABLE "b"',
    ]);
  });
});

describe('tablesTouchedBy', () => {
  it('lists the tables a script alters, drops, empties or writes to', () => {
    expect(
      tablesTouchedBy(`
        CREATE TABLE nuova (id int);
        ALTER TABLE IF EXISTS public.prodotti ADD COLUMN prezzo int;
        DROP TABLE "Vecchia";
        TRUNCATE TABLE ordini;
        UPDATE clienti SET attivo = true;
        CREATE UNIQUE INDEX idx ON prodotti (nome);
        SELECT * FROM lette;
      `),
    ).toEqual(['Vecchia', 'clienti', 'ordini', 'prodotti']);
  });

  it('ignores additive changes that touch no existing data', () => {
    expect(tablesTouchedBy('CREATE TABLE a (id int); CREATE INDEX i ON a (id);')).toEqual(['a']);
  });
});

describe('readSiteMigrations', () => {
  let dir: string;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('reads the sql files under db/migrations at a commit', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-migrations-'));
    await runGit(['init', '--quiet', '-b', 'main', dir]);
    await mkdir(join(dir, 'db', 'migrations', 'meta'), { recursive: true });
    await writeFile(join(dir, 'db', 'migrations', '0001_b.sql'), 'CREATE TABLE b ();');
    await writeFile(join(dir, 'db', 'migrations', '0000_a.sql'), 'CREATE TABLE a ();');
    await writeFile(join(dir, 'db', 'migrations', 'meta', '_journal.json'), '{}');
    await runGit(['add', '--all'], { cwd: dir });
    await runGit(['commit', '--quiet', '-m', 'm'], { cwd: dir });
    const commit = (await runGit(['rev-parse', 'HEAD'], { cwd: dir })).trim();
    const migrations = await readSiteMigrations(dir, commit);
    expect(migrations.map((m) => [m.name, m.sql])).toEqual([
      ['0000_a.sql', 'CREATE TABLE a ();'],
      ['0001_b.sql', 'CREATE TABLE b ();'],
    ]);
    expect(migrations[0]!.blob).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe.skipIf(!testDatabaseUrl)('applySiteMigrations', () => {
  const name = `mig_${randomBytes(6).toString('hex')}`;
  let admin: postgres.Sql;
  let url: string;

  beforeAll(async () => {
    admin = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const u = new URL(testDatabaseUrl!);
    u.pathname = `/${name}`;
    url = u.toString();
  });

  afterAll(async () => {
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  const m = (file: string, sql: string) => ({ name: file, sql, blob: '' });

  it('applies missing migrations once, in order', async () => {
    const first = [m('0000_a.sql', 'CREATE TABLE a (id int);')];
    expect(await applySiteMigrations(url, first)).toEqual({
      applied: ['0000_a.sql'],
      alreadyApplied: [],
      needsReset: false,
    });
    const second = [...first, m('0001_b.sql', 'ALTER TABLE a ADD COLUMN b text;')];
    expect(await applySiteMigrations(url, second)).toEqual({
      applied: ['0001_b.sql'],
      alreadyApplied: ['0000_a.sql'],
      needsReset: false,
    });
  });

  it('records the baseline without running it on an untracked database', async () => {
    const other = `${name}_b`;
    await admin.unsafe(`CREATE DATABASE ${other}`);
    const u = new URL(testDatabaseUrl!);
    u.pathname = `/${other}`;
    try {
      const result = await applySiteMigrations(
        u.toString(),
        [m('0000_old.sql', 'SELECT * FROM non_esiste;'), m('0001_new.sql', 'CREATE TABLE n ();')],
        { baseline: ['0000_old.sql'] },
      );
      expect(result).toEqual({
        applied: ['0001_new.sql'],
        alreadyApplied: ['0000_old.sql'],
        needsReset: false,
      });
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${other} WITH (FORCE)`);
    }
  });

  it('asks for a reset when an applied migration changed', async () => {
    const changed = [m('0000_a.sql', 'CREATE TABLE a (id bigint);')];
    expect((await applySiteMigrations(url, changed)).needsReset).toBe(true);
  });

  it('rolls back a failing migration and names it', async () => {
    const list = [
      m('0000_a.sql', 'CREATE TABLE a (id int);'),
      m('0001_b.sql', 'ALTER TABLE a ADD COLUMN b text;'),
      m('0002_c.sql', 'CREATE TABLE c (id int); SELECT * FROM non_esiste;'),
    ];
    const error = await applySiteMigrations(url, list).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).migration).toBe('0002_c.sql');
    const sql = postgres(url, { max: 1 });
    expect(await sql`SELECT to_regclass('c') AS c`).toEqual([{ c: null }]);
    await sql.end();
  });

  it('applies all the missing migrations in one transaction, or none', async () => {
    const list = [
      m('0000_a.sql', 'CREATE TABLE a (id int);'),
      m('0001_b.sql', 'ALTER TABLE a ADD COLUMN b text;'),
      m('0002_c.sql', 'CREATE TABLE c (id int);'),
      m('0003_d.sql', 'CREATE TABLE d (id int); SELECT * FROM non_esiste;'),
    ];
    const error = await applySiteMigrations(url, list, { atomic: true }).catch((e: unknown) => e);
    expect((error as MigrationError).migration).toBe('0003_d.sql');
    const sql = postgres(url, { max: 1 });
    expect(await sql`SELECT to_regclass('c') AS c`).toEqual([{ c: null }]);
    expect(await sql`SELECT name FROM _cms.migrations ORDER BY name`).toEqual([
      { name: '0000_a.sql' },
      { name: '0001_b.sql' },
    ]);
    await sql.end();

    const result = await applySiteMigrations(url, list.slice(0, 3), { atomic: true });
    expect(result.applied).toEqual(['0002_c.sql']);
  });

  it('lists the migrations a database has not applied', async () => {
    const list = [
      m('0000_a.sql', 'CREATE TABLE a (id int);'),
      m('0004_e.sql', 'CREATE TABLE e (id int);'),
    ];
    expect((await pendingSiteMigrations(url, list)).map((x) => x.name)).toEqual(['0004_e.sql']);
    expect(await pendingSiteMigrations(testDatabaseUrl!, list)).toHaveLength(2);
  });
});
