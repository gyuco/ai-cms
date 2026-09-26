import { coreDatabaseUrl, createDatabase, type Database } from '@ai-cms/db';

let database: Database | undefined;

/** Runtime connection pool as cms_api (DML only, no DDL). */
export function db(): Database {
  database ??= createDatabase(coreDatabaseUrl('api')).db;
  return database;
}
