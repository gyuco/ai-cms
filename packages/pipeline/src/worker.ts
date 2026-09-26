import { randomUUID } from 'node:crypto';
import type { Database } from '@ai-cms/db';
import type { Sql } from 'postgres';
import { claim, complete, fail, recoverStaleJobs, type Job } from './queue.ts';

export type JobHandler = (payload: unknown, job: Job) => Promise<unknown>;

export interface WorkerOptions {
  db: Database;
  /** postgres.js client used for LISTEN on the `jobs` channel. */
  sql: Sql;
  handlers: Record<string, JobHandler>;
  concurrency?: number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/**
 * Runs jobs until the signal aborts. Wakes on NOTIFY and also polls, so scheduled jobs
 * (run_at in the future) and missed notifications are still picked up.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const workerId = `worker-${randomUUID().slice(0, 8)}`;
  const types = Object.keys(options.handlers);
  const concurrency = options.concurrency ?? 2;
  const log = options.log ?? (() => {});
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  const listener = await options.sql.listen('jobs', wake);
  const poll = setInterval(wake, options.pollIntervalMs ?? 2_000);
  const staleTimer = setInterval(
    () => void recoverStaleJobs(options.db, options.staleAfterMs ?? 15 * 60_000),
    60_000,
  );
  options.signal?.addEventListener('abort', wake);

  async function lane() {
    while (!options.signal?.aborted) {
      const job = await claim(options.db, workerId, types);
      if (!job) {
        await new Promise<void>((resolve) => waiters.add(resolve));
        continue;
      }
      try {
        const result = await options.handlers[job.type]!(job.payload, job);
        await complete(options.db, job.id, result);
        log(`job ${job.id} ${job.type}: done`);
      } catch (error) {
        await fail(options.db, job, error);
        log(`job ${job.id} ${job.type}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, lane));
  } finally {
    clearInterval(poll);
    clearInterval(staleTimer);
    await listener.unlisten();
  }
}
