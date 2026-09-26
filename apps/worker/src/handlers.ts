import { deleteExpiredSessions } from '@ai-cms/auth';
import type { Database } from '@ai-cms/db';
import type { JobHandler } from '@ai-cms/pipeline';

/** Job type → handler. New job types (checks, builds, releases, sync) register here. */
export function createHandlers(db: Database): Record<string, JobHandler> {
  return {
    'sessions.cleanup': async () => {
      await deleteExpiredSessions(db);
      return { ok: true };
    },
  };
}

/** Recurring maintenance jobs, enqueued periodically (deduplicated). */
export const recurringJobs = [{ type: 'sessions.cleanup', everyMs: 60 * 60 * 1000 }];
