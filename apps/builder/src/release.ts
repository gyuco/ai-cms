import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RELEASE_SERVER_FILE,
  isChangesetId,
  isCommitId,
  type BuilderReleaseRequest,
  type BuilderReleaseResult,
} from '@ai-cms/pipeline/builder';
import { assembleStandalone } from './artifact.ts';
import { runCommand, siteEnv, type RunCommand } from './exec.ts';
import { prepareWorkspace, SITE_DIR } from './workspace.ts';

export interface ReleaseBuildConfig {
  platformRoot: string;
  workRoot: string;
  /** Changeset clones (`/data/workspaces`, read-only). */
  workspacesRoot: string;
  /** Release artifacts, `<releasesRoot>/<releaseId>` (`/data/releases`). */
  releasesRoot: string;
  /** Read-only URL of the published content, given to the built site (CORE_DATABASE_URL). */
  contentDatabaseUrl?: string;
  timeouts?: Partial<Record<'install' | 'build', number>>;
}

export interface ReleaseBuildTools {
  exec: RunCommand;
  prepare: typeof prepareWorkspace;
  assemble: typeof assembleStandalone;
}

export const defaultReleaseTools: ReleaseBuildTools = {
  exec: runCommand,
  prepare: prepareWorkspace,
  assemble: assembleStandalone,
};

const MINUTE = 60_000;

export class ReleaseBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseBuildError';
  }
}

/** Validates a `POST /releases` body; returns an Italian error message or the request. */
export function parseReleaseRequest(body: unknown): BuilderReleaseRequest | string {
  const b = (body ?? {}) as Record<string, unknown>;
  // Release ids are UUIDs, like changeset ids.
  if (!isChangesetId(b.releaseId)) return 'releaseId non valido';
  if (!isChangesetId(b.changesetId)) return 'changesetId non valido';
  if (!isCommitId(b.commit)) return 'commit non valido';
  return { releaseId: b.releaseId, changesetId: b.changesetId, commit: b.commit };
}

/**
 * Builds the final artifact of a release (TECHNICAL §8.4 step 3): the commit of the changeset
 * clone, installed offline from the platform lockfile and built for production, assembled in
 * `<releasesRoot>/<releaseId>` with a `SERVER` file naming the server to start. The artifact
 * appears atomically, so a half-built release is never served.
 */
export async function buildReleaseArtifact(
  request: BuilderReleaseRequest,
  config: ReleaseBuildConfig,
  tools: ReleaseBuildTools = defaultReleaseTools,
): Promise<BuilderReleaseResult> {
  const workspace = await tools
    .prepare({
      platformRoot: config.platformRoot,
      workRoot: config.workRoot,
      clone: join(config.workspacesRoot, request.changesetId),
      commit: request.commit,
      exec: tools.exec,
      env: siteEnv(config.workRoot),
    })
    .catch((error: unknown) => {
      throw new ReleaseBuildError(
        `Preparazione del sito non riuscita: ${(error as Error).message}`,
      );
    });
  await mkdir(config.releasesRoot, { recursive: true });
  const tmp = join(config.releasesRoot, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    const { repo, site, home } = workspace;
    const env = siteEnv(home);
    const install = await tools.exec(
      'pnpm',
      [
        'install',
        '--frozen-lockfile',
        '--offline',
        '--ignore-scripts',
        '--reporter=append-only',
        '--filter',
        `{./${SITE_DIR}}...`,
        '--filter',
        '.',
      ],
      { cwd: repo, env, timeoutMs: config.timeouts?.install ?? 5 * MINUTE },
    );
    if (install.code !== 0) {
      throw new ReleaseBuildError(
        `Installazione delle dipendenze non riuscita:\n${install.output}`,
      );
    }
    const build = await tools.exec(join(site, 'node_modules', '.bin', 'next'), ['build'], {
      cwd: site,
      env: {
        ...env,
        CMS_ENV: 'prod',
        NODE_ENV: 'production',
        ...(config.contentDatabaseUrl ? { CORE_DATABASE_URL: config.contentDatabaseUrl } : {}),
      },
      timeoutMs: config.timeouts?.build ?? 15 * MINUTE,
    });
    if (build.code !== 0) throw new ReleaseBuildError(`next build:\n${build.output}`);

    const server = await tools.assemble({ repo, site }, tmp);
    await writeFile(join(tmp, RELEASE_SERVER_FILE), `${server}\n`, { mode: 0o644 });
    await writeFile(
      join(tmp, 'release.json'),
      `${JSON.stringify({ ...request, server, builtAt: new Date().toISOString() }, null, 2)}\n`,
    );
    const dir = join(config.releasesRoot, request.releaseId);
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    return { releaseId: request.releaseId, commit: request.commit, server };
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(workspace.dir, { recursive: true, force: true });
  }
}
