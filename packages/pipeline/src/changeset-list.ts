import { schema, type Database } from '@ai-cms/db';
import { desc, eq, inArray } from 'drizzle-orm';
import { openChangesetStatuses, type ChangesetStatus } from './changesets.ts';
import type { ReleaseUser } from './release-history.ts';

/** One open changeset as the Development tab lists it (E7.11). */
export interface OpenChangesetEntry {
  id: string;
  title: string;
  status: ChangesetStatus;
  author: ReleaseUser | null;
  headCommit: string | null;
  /** The chat with the developer agent this changeset was opened from, if any. */
  conversationId: string | null;
  /** True when "Approva e pubblica" must warn about a destructive migration. */
  destructiveMigration: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The changesets still being worked on or released, most recently updated first. */
export async function listOpenChangesets(db: Database): Promise<OpenChangesetEntry[]> {
  const rows = await db
    .select({
      id: schema.changesets.id,
      title: schema.changesets.title,
      status: schema.changesets.status,
      headCommit: schema.changesets.headCommit,
      conversationId: schema.changesets.conversationId,
      destructiveMigration: schema.changesets.destructiveMigration,
      createdAt: schema.changesets.createdAt,
      updatedAt: schema.changesets.updatedAt,
      uid: schema.users.uid,
      username: schema.users.username,
      displayName: schema.users.displayName,
    })
    .from(schema.changesets)
    .leftJoin(schema.users, eq(schema.users.uid, schema.changesets.authorUid))
    .where(inArray(schema.changesets.status, [...openChangesetStatuses]))
    .orderBy(desc(schema.changesets.updatedAt));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    author:
      row.uid === null
        ? null
        : { uid: row.uid, username: row.username ?? '', displayName: row.displayName },
    headCommit: row.headCommit,
    conversationId: row.conversationId,
    destructiveMigration: row.destructiveMigration,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}
