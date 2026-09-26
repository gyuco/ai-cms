import { fileURLToPath } from 'node:url';
import { deleteExpiredSessions } from '@ai-cms/auth';
import type { Database } from '@ai-cms/db';
import {
  closeChangeset,
  initSiteRepo,
  recordWork,
  siteRepoPaths,
  type JobHandler,
  type SiteRepoPaths,
} from '@ai-cms/pipeline';

export interface HandlerOptions {
  site?: SiteRepoPaths;
  /** The site skeleton imported into site.git on first start. */
  templateDir?: string;
}

const defaultTemplateDir =
  process.env.SITE_TEMPLATE_DIR ||
  fileURLToPath(new URL('../../../templates/site', import.meta.url));

/** Job type → handler. New job types (checks, builds, releases, sync) register here. */
export function createHandlers(
  db: Database,
  options: HandlerOptions = {},
): Record<string, JobHandler> {
  const site = options.site ?? siteRepoPaths();
  const templateDir = options.templateDir ?? defaultTemplateDir;
  return {
    'sessions.cleanup': async () => {
      await deleteExpiredSessions(db);
      return { ok: true };
    },
    'site.init': async () => initSiteRepo({ gitRoot: site.gitRoot, templateDir }),
    'changeset.record': async (payload) => recordWork(db, changesetIdOf(payload), site),
    'changeset.close': async (payload) => {
      const changeset = await closeChangeset(db, changesetIdOf(payload), site);
      return { status: changeset.status };
    },
  };
}

function changesetIdOf(payload: unknown): string {
  const id = (payload as { changesetId?: unknown } | null)?.changesetId;
  if (typeof id !== 'string') throw new Error('payload.changesetId mancante');
  return id;
}

/** Recurring maintenance jobs, enqueued periodically (deduplicated). */
export const recurringJobs = [{ type: 'sessions.cleanup', everyMs: 60 * 60 * 1000 }];

/** Jobs enqueued once at every worker start (deduplicated). */
export const startupJobs = ['site.init'];
