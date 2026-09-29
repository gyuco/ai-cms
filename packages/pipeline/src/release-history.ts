import { schema, type Database } from '@ai-cms/db';
import { desc, inArray, lt } from 'drizzle-orm';

export interface ReleaseUser {
  uid: number;
  username: string;
  displayName: string | null;
}

/** One entry of the release history as the Development tab shows it (E7.11). */
export interface ReleaseHistoryEntry {
  id: string;
  number: number;
  /** The git tag of the release, `release-<number>`. */
  tag: string;
  status: (typeof schema.releases.$inferSelect)['status'];
  commit: string | null;
  /** The person who approved the release. */
  approvedBy: ReleaseUser | null;
  /** The changesets the release carried, with their authors. */
  changesets: Array<{
    id: string;
    title: string;
    author: ReleaseUser | null;
  }>;
  previousReleaseId: string | null;
  /** Why the release failed; null otherwise. */
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** True for the release production is serving. */
  current: boolean;
  /** True when "Rollback" is offered: it is the current release and an earlier one exists. */
  canRollback: boolean;
}

export interface ReleaseHistory {
  releases: ReleaseHistoryEntry[];
  /** Pass as `before` to get the next (older) page; null on the last one. */
  nextBefore: number | null;
}

export interface ReleaseHistoryOptions {
  /** Entries per page (default 50, at most 200). */
  limit?: number;
  /** Only releases numbered below this one: pagination. */
  before?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The releases, newest first, with author, approver, date, changesets and outcome (FR-54).
 * `current` is the newest successful release; a rolled back or failed one never is.
 */
export async function listReleases(
  db: Database,
  options: ReleaseHistoryOptions = {},
): Promise<ReleaseHistory> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const rows = await db
    .select()
    .from(schema.releases)
    .where(options.before === undefined ? undefined : lt(schema.releases.number, options.before))
    .orderBy(desc(schema.releases.number))
    .limit(limit + 1);
  const page = rows.slice(0, limit);

  const changesetIds = [...new Set(page.flatMap((r) => r.changesetIds))];
  const changesets = changesetIds.length
    ? await db
        .select({
          id: schema.changesets.id,
          title: schema.changesets.title,
          authorUid: schema.changesets.authorUid,
        })
        .from(schema.changesets)
        .where(inArray(schema.changesets.id, changesetIds))
    : [];
  const uids = [
    ...new Set([...page.map((r) => r.approvedBy), ...changesets.map((c) => c.authorUid)]),
  ];
  const users = uids.length
    ? await db
        .select({
          uid: schema.users.uid,
          username: schema.users.username,
          displayName: schema.users.displayName,
        })
        .from(schema.users)
        .where(inArray(schema.users.uid, uids))
    : [];
  const userOf = (uid: number): ReleaseUser | null => users.find((u) => u.uid === uid) ?? null;
  const changesetOf = new Map(changesets.map((c) => [c.id, c]));

  // Which release is serving is decided over the whole table, not only over this page.
  const released = await db
    .select({ id: schema.releases.id, number: schema.releases.number })
    .from(schema.releases)
    .where(inArray(schema.releases.status, ['released']))
    .orderBy(desc(schema.releases.number))
    .limit(2);
  const currentId = released[0]?.id ?? null;
  const hasEarlier = released.length > 1;

  const releases = page.map((r): ReleaseHistoryEntry => {
    const current = r.id === currentId;
    return {
      id: r.id,
      number: r.number,
      tag: `release-${String(r.number)}`,
      status: r.status,
      commit: r.commit,
      approvedBy: userOf(r.approvedBy),
      changesets: r.changesetIds.map((id) => {
        const c = changesetOf.get(id);
        return {
          id,
          title: c?.title ?? '(changeset eliminato)',
          author: c ? userOf(c.authorUid) : null,
        };
      }),
      previousReleaseId: r.previousReleaseId,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      current,
      canRollback: current && hasEarlier,
    };
  });
  const last = releases[releases.length - 1];
  return { releases, nextBefore: rows.length > limit && last ? last.number : null };
}
