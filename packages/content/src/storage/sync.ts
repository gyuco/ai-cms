import { CopyObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { Principal } from '@ai-cms/authz';
import { fromLtree } from '@ai-cms/authz';
import type { Executor } from '@ai-cms/tree';
import { sql } from 'drizzle-orm';
import { getContent, publish, saveDraft } from '../service/versions.ts';
import type { AssetStorage } from './s3.ts';

export interface SyncResult {
  /** Public paths whose staging content was replaced with the production one. */
  updated: string[];
  unchanged: number;
  /** Asset objects copied between the environment buckets. */
  copiedObjects: number;
  failed: { path: string; message: string }[];
}

// Deterministic comparison of JSON bodies (key order does not matter).
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

/**
 * Copies what is published in production to staging (E10.10): each published node gets a
 * new staging version with the production body, published; asset files are copied between
 * buckets. Staging-only pages are left alone. Runs as `principal` (normally the system user),
 * so every write goes through authorization and audit.
 */
export async function syncProdToStaging(
  db: Executor,
  principal: Principal,
  storage?: AssetStorage,
): Promise<SyncResult> {
  const rows = (await db.execute(sql`
    SELECT path::text AS path, kind, node_id, body FROM published_content
    WHERE env = 'prod' ORDER BY nlevel(path), path`)) as unknown as {
    path: string;
    kind: string;
    node_id: string;
    body: unknown;
  }[];

  const result: SyncResult = { updated: [], unchanged: 0, copiedObjects: 0, failed: [] };
  for (const row of rows) {
    const path = fromLtree(row.path);
    try {
      const current = await getContent(db, principal, 'staging', path, { version: 'published' })
        .then((c) => c.body)
        .catch(() => undefined);
      if (current !== undefined && canonical(current) === canonical(row.body)) {
        result.unchanged++;
      } else {
        await saveDraft(db, principal, 'staging', path, row.body, { viaAgent: null });
        await publish(db, principal, 'staging', path);
        result.updated.push(path);
      }
      if (row.kind === 'asset' && storage) {
        result.copiedObjects += await copyAssetObjects(storage, row.node_id);
      }
    } catch (error) {
      result.failed.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

async function copyAssetObjects(storage: AssetStorage, nodeId: string): Promise<number> {
  const listed = await storage.client.send(
    new ListObjectsV2Command({ Bucket: storage.buckets.prod, Prefix: `${nodeId}/` }),
  );
  let copied = 0;
  for (const object of listed.Contents ?? []) {
    if (!object.Key) continue;
    await storage.client.send(
      new CopyObjectCommand({
        Bucket: storage.buckets.staging,
        Key: object.Key,
        CopySource: `${storage.buckets.prod}/${object.Key}`,
      }),
    );
    copied++;
  }
  return copied;
}
