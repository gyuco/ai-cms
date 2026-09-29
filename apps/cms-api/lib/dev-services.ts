import type { DevChecksState, DevQueryResult, DevServices } from '@ai-cms/mcp-tools';
import { appDatabaseUrl, createDatabase, schema, type Database } from '@ai-cms/db';
import {
  changesetDatabaseName,
  CHECK_NAMES,
  enqueue,
  isChangesetId,
  summarizeChecks,
  type CheckName,
} from '@ai-cms/pipeline';
import { and, eq } from 'drizzle-orm';
import { db } from './db.ts';

/** Rows the agent gets back from `query_staging_db`. */
export const QUERY_ROW_LIMIT = 200;
const QUERY_TIMEOUT = '5s';

/** Runs one statement on the database of a changeset, read-only; injected in tests. */
export type StagingQuery = (
  changesetId: string,
  statement: string,
  limit: number,
) => Promise<{ columns: string[]; rows: unknown[][] }>;

/**
 * Connection as `site_app`, the role the site itself uses, opened per call: the agent queries
 * rarely, and the changeset database can be dropped at any time. The transaction is read-only,
 * so even a statement the tool's own check let through cannot change anything.
 */
export const queryChangesetDatabase: StagingQuery = async (changesetId, statement, limit) => {
  const connection = createDatabase(
    appDatabaseUrl('staging', 'app', changesetDatabaseName(changesetId)),
    { max: 1 },
  );
  try {
    const wrapped = /^(select|with)\b/i.test(statement)
      ? `SELECT * FROM (${statement}) AS agent_query LIMIT ${limit + 1}`
      : statement;
    const result = await connection.sql.begin('read only', async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '${QUERY_TIMEOUT}'`);
      return tx.unsafe(wrapped).values();
    });
    return {
      columns: result.columns.map((column) => column.name),
      rows: [...result] as unknown[][],
    };
  } finally {
    await connection.close();
  }
};

export interface DevServicesOptions {
  db?: Database;
  query?: StagingQuery;
  /** Base of the preview hosts: `cs-<id>` + this. `PREVIEW_DOMAIN` or `.localhost`. */
  previewSuffix?: string;
}

function assertChangesetId(id: string): void {
  if (!isChangesetId(id)) throw new Error(`Id di changeset non valido: ${id}`);
}

/** The developer-agent tools' view of the pipeline (E10.6). */
export function createDevServices(options: DevServicesOptions = {}): DevServices {
  const database = () => options.db ?? db();
  const query = options.query ?? queryChangesetDatabase;
  const suffix = options.previewSuffix ?? process.env.PREVIEW_DOMAIN ?? '.localhost';

  async function loadChangeset(id: string) {
    assertChangesetId(id);
    const [row] = await database()
      .select()
      .from(schema.changesets)
      .where(eq(schema.changesets.id, id));
    if (!row) throw new Error(`Changeset ${id} non trovato`);
    return row;
  }

  async function getCheckResults(id: string): Promise<DevChecksState> {
    const changeset = await loadChangeset(id);
    const commit = changeset.headCommit;
    const rows = commit
      ? await database()
          .select()
          .from(schema.checkRuns)
          .where(and(eq(schema.checkRuns.changesetId, id), eq(schema.checkRuns.commit, commit)))
      : [];
    const byName = new Map(rows.map((row) => [row.checkName, row]));
    // Checks with no row yet are still to come: `queued`, in the order of TECHNICAL §8.2.
    const checks = rows.length
      ? CHECK_NAMES.map((name: CheckName) => ({
          name,
          status: byName.get(name)?.status ?? ('queued' as const),
          output: byName.get(name)?.output ?? null,
        }))
      : [];
    const summary = summarizeChecks(checks);
    const running = changeset.status === 'checking';
    return {
      changesetStatus: changeset.status,
      commit,
      checks,
      ok: summary.ok && changeset.status === 'ready',
      failed: summary.failed,
      // The job is queued or just started: no row exists yet, but everything is still to run.
      pending: running && rows.length === 0 ? [...CHECK_NAMES] : summary.pending,
    };
  }

  return {
    async runChecks(id) {
      const changeset = await loadChangeset(id);
      if (!['draft', 'checks_failed', 'checking'].includes(changeset.status)) {
        throw new Error(
          `Il changeset è nello stato "${changeset.status}": non si possono eseguire i controlli.`,
        );
      }
      const jobId = await enqueue(
        database(),
        'changeset.check',
        { changesetId: id },
        { dedupeKey: `changeset.check:${id}` },
      );
      return { queued: jobId !== null };
    },
    getCheckResults,
    async queryStagingDb(id, statement): Promise<DevQueryResult> {
      await loadChangeset(id);
      const { columns, rows } = await query(id, statement, QUERY_ROW_LIMIT);
      return {
        columns,
        rows: rows.slice(0, QUERY_ROW_LIMIT),
        truncated: rows.length > QUERY_ROW_LIMIT,
      };
    },
    async previewUrl(id) {
      await loadChangeset(id);
      const state = await getCheckResults(id);
      // The preview serves the artifact of the last successful build (TECHNICAL §8.3).
      const built = state.checks.some((c) => c.name === 'build' && c.status === 'passed');
      return { url: `http://cs-${id}${suffix}`, ready: built };
    },
  };
}
