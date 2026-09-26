import { schema, type Database } from '@ai-cms/db';
import { eq, sql } from 'drizzle-orm';

export type Job = typeof schema.jobs.$inferSelect;

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /** At most one queued or running job per key; duplicates are ignored. */
  dedupeKey?: string;
}

/** Adds a job; returns its id, or null when an active job with the same dedupe key exists. */
export async function enqueue(
  db: Database,
  type: string,
  payload: Record<string, unknown> = {},
  options: EnqueueOptions = {},
): Promise<number | null> {
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO jobs (type, payload, run_at, max_attempts, dedupe_key)
    VALUES (
      ${type},
      ${JSON.stringify(payload)}::jsonb,
      ${(options.runAt ?? new Date()).toISOString()}::timestamptz,
      ${options.maxAttempts ?? 3},
      ${options.dedupeKey ?? null}
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running')
    DO NOTHING
    RETURNING id`);
  return rows[0]?.id === undefined ? null : Number(rows[0].id);
}

/** Atomically takes the oldest due job of the given types, skipping rows locked by others. */
export async function claim(db: Database, workerId: string, types: string[]): Promise<Job | null> {
  if (types.length === 0) return null;
  const rows = await db.execute(sql`
    UPDATE jobs SET status = 'running', locked_by = ${workerId}, locked_at = now(),
      attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_at <= now()
        AND type IN (${sql.join(
          types.map((t) => sql`${t}`),
          sql`, `,
        )})
      ORDER BY run_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`);
  const id = rows[0]?.id;
  if (id === undefined) return null;
  const [job] = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, Number(id)));
  return job ?? null;
}

export async function complete(db: Database, id: number, result: unknown = null): Promise<void> {
  await db
    .update(schema.jobs)
    .set({ status: 'done', result: result ?? null, finishedAt: new Date(), lockedBy: null })
    .where(eq(schema.jobs.id, id));
}

/** Exponential backoff: 5s, 10s, 20s, … capped at 10 minutes. */
export function retryDelayMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(attempts - 1, 0), 600_000);
}

/** Requeues the job with backoff, or marks it failed after its last attempt. */
export async function fail(db: Database, job: Job, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const final = job.attempts >= job.maxAttempts;
  await db
    .update(schema.jobs)
    .set({
      status: final ? 'failed' : 'queued',
      lastError: message.slice(0, 4000),
      runAt: final ? job.runAt : new Date(Date.now() + retryDelayMs(job.attempts)),
      finishedAt: final ? new Date() : null,
      lockedBy: null,
    })
    .where(eq(schema.jobs.id, job.id));
}

/** Puts back jobs whose worker died while running them. */
export async function recoverStaleJobs(db: Database, olderThanMs: number): Promise<number> {
  const rows = await db.execute(sql`
    UPDATE jobs SET status = 'queued', locked_by = NULL
    WHERE status = 'running' AND locked_at < now() - make_interval(secs => ${olderThanMs / 1000})
    RETURNING id`);
  return rows.length;
}
