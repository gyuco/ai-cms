import { fileURLToPath } from 'node:url';
import { deleteExpiredSessions } from '@ai-cms/auth';
import { appDatabaseUrl, type Database } from '@ai-cms/db';
import {
  closeChangeset,
  createChangeset,
  createChangesetDatabase,
  dropChangesetDatabase,
  initSiteRepo,
  recordWork,
  siteRepoPaths,
  type JobHandler,
  type SiteRepoPaths,
} from '@ai-cms/pipeline';
import { stagingSyncHandler } from './staging-sync.ts';

export interface HandlerOptions {
  site?: SiteRepoPaths;
  /** The site skeleton imported into site.git on first start. */
  templateDir?: string;
  /**
   * app_owner connection to the staging Postgres, on a database other than app_staging
   * (a template must have no open connections to be cloned).
   */
  stagingAdminUrl?: () => string;
  /** Database cloned for each changeset; `app_staging` by default. */
  stagingTemplate?: string;
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
  const stagingAdminUrl =
    options.stagingAdminUrl ?? (() => appDatabaseUrl('staging', 'owner', 'postgres'));
  return {
    'sessions.cleanup': async () => {
      await deleteExpiredSessions(db);
      return { ok: true };
    },
    'staging.sync': stagingSyncHandler(db),
    'site.init': async () => initSiteRepo({ gitRoot: site.gitRoot, templateDir }),
    // Payload: { title, description?, authorUid, conversationId? }.
    'changeset.create': async (payload) => {
      const input = (payload ?? {}) as Record<string, unknown>;
      if (typeof input.title !== 'string' || typeof input.authorUid !== 'number') {
        throw new Error('payload.title o payload.authorUid mancante');
      }
      const changeset = await createChangeset(
        db,
        {
          title: input.title,
          description: typeof input.description === 'string' ? input.description : null,
          authorUid: input.authorUid,
          conversationId: typeof input.conversationId === 'string' ? input.conversationId : null,
        },
        site,
      );
      try {
        const database = await createChangesetDatabase(stagingAdminUrl(), changeset.id, {
          template: options.stagingTemplate,
        });
        return { changesetId: changeset.id, branch: changeset.branch, database };
      } catch (error) {
        // A retry creates a new changeset, so do not leave this one half set up.
        await closeChangeset(db, changeset.id, site);
        throw error;
      }
    },
    // Payload: { changesetId }.
    'changeset.record': async (payload) => recordWork(db, changesetIdOf(payload), site),
    // Payload: { changesetId }.
    'changeset.close': async (payload) => {
      const id = changesetIdOf(payload);
      const changeset = await closeChangeset(db, id, site);
      await dropChangesetDatabase(stagingAdminUrl(), id);
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
