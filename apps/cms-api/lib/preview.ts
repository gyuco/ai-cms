import type { NodeTarget, Storage } from '@ai-cms/authz';
import { sql } from 'drizzle-orm';
import { db } from './db.ts';
import type { Env } from './http.ts';

export interface LatestPageVersion {
  target: NodeTarget;
  body: unknown;
  version: number;
  /** True when this version is the one published in `env`. */
  published: boolean;
}

/**
 * Latest version of a page node in `env`, published or not (FR-150). Null when the node does
 * not exist, is not a page, is not part of `env` or has no version there yet.
 */
export async function latestPageVersion(
  env: Env,
  nodePath: string,
): Promise<LatestPageVersion | null> {
  const rows = await db().execute<{
    path: string;
    kind: string;
    storage: string;
    body: unknown;
    version: number | string;
    published: boolean;
  }>(sql`
    SELECT n.path::text AS path, n.kind, n.storage, v.body, v.version,
           COALESCE(p.version_id = v.id AND p.status = 'published', false) AS published
    FROM nodes n
    JOIN LATERAL (
      SELECT id, body, version FROM content_versions
      WHERE node_id = n.id AND env = ${env}
      ORDER BY version DESC
      LIMIT 1
    ) v ON true
    LEFT JOIN publications p ON p.node_id = n.id AND p.env = ${env}
    WHERE n.path = ${nodePath}::ltree
      AND n.deleted_at IS NULL
      AND n.kind = 'page'
      AND n.env IN (${env}, 'both')`);
  const row = rows[0];
  if (!row) return null;
  return {
    target: { path: row.path, kind: row.kind, storage: row.storage as Storage },
    body: row.body,
    version: Number(row.version),
    published: row.published,
  };
}
