import { randomBytes } from 'node:crypto';
import { access, cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isChangesetId, type PreviewConfig } from '@ai-cms/pipeline/builder';

export const PREVIEW_FILE = 'preview.json';

/** Artifacts kept per changeset: the newest and the one a preview may still be serving. */
const KEEP = 2;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function changesetArtifactsDir(artifactsRoot: string, changesetId: string): string {
  if (!isChangesetId(changesetId)) throw new Error(`Id di changeset non valido: ${changesetId}`);
  return join(artifactsRoot, changesetId);
}

export interface SaveArtifactOptions {
  artifactsRoot: string;
  changesetId: string;
  commit: string;
  /** Monorepo copy the site was built in. */
  repo: string;
  /** `<repo>/templates/site`, containing `.next/standalone`. */
  site: string;
  /** Environment of the preview (changeset database only). */
  env: Record<string, string>;
}

export interface SavedArtifact {
  dir: string;
  /** Absolute path of `server.js`. */
  server: string;
  preview: PreviewConfig;
}

export interface AssembleOptions {
  /** Monorepo copy the site was built in. */
  repo: string;
  /** `<repo>/templates/site`, containing `.next/standalone`. */
  site: string;
}

/**
 * Copies a `next build` with `output: 'standalone'` into `dest` (an existing empty directory),
 * adding the static files and `public/`. Returns the server path relative to `dest`.
 */
export async function assembleStandalone(options: AssembleOptions, dest: string): Promise<string> {
  const standalone = join(options.site, '.next', 'standalone');
  if (!(await exists(standalone))) {
    throw new Error(
      "La build non ha prodotto .next/standalone: next.config deve mantenere output: 'standalone'.",
    );
  }
  const siteRel = relative(options.repo, options.site);
  const serverRel = (await exists(join(standalone, siteRel, 'server.js')))
    ? join(siteRel, 'server.js')
    : 'server.js';
  const appRel = serverRel === 'server.js' ? '' : siteRel;
  if (!(await exists(join(standalone, serverRel)))) {
    throw new Error('La build non ha prodotto il server standalone (server.js).');
  }
  await cp(standalone, dest, { recursive: true, verbatimSymlinks: true });
  await cp(join(options.site, '.next', 'static'), join(dest, appRel, '.next', 'static'), {
    recursive: true,
  });
  if (await exists(join(options.site, 'public'))) {
    await cp(join(options.site, 'public'), join(dest, appRel, 'public'), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  return serverRel;
}

/**
 * Turns a `next build` with `output: 'standalone'` into a self-contained artifact in
 * `<artifactsRoot>/<changesetId>/<commit>`: the standalone server plus static files and
 * `public/`. Then points `preview.json` at it, atomically.
 */
export async function saveArtifact(options: SaveArtifactOptions): Promise<SavedArtifact> {
  const base = changesetArtifactsDir(options.artifactsRoot, options.changesetId);
  await mkdir(base, { recursive: true });
  const tmp = join(base, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    const serverRel = await assembleStandalone(options, tmp);
    const dir = join(base, options.commit);
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);

    const preview: PreviewConfig = {
      changesetId: options.changesetId,
      commit: options.commit,
      artifact: options.commit,
      server: serverRel,
      env: options.env,
      builtAt: new Date().toISOString(),
    };
    const previewTmp = join(base, `.${PREVIEW_FILE}.${randomBytes(4).toString('hex')}`);
    await writeFile(previewTmp, `${JSON.stringify(preview, null, 2)}\n`, { mode: 0o644 });
    await rename(previewTmp, join(base, PREVIEW_FILE));
    await pruneArtifacts(base, options.commit);
    return { dir, server: join(dir, serverRel), preview };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Keeps the newest artifacts of a changeset and removes the rest. */
async function pruneArtifacts(base: string, current: string): Promise<void> {
  const entries = await readdir(base, { withFileTypes: true });
  const dirs = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== current)
      .map(async (e) => ({ name: e.name, mtime: (await stat(join(base, e.name))).mtimeMs })),
  );
  dirs.sort((a, b) => b.mtime - a.mtime);
  for (const old of dirs.slice(KEEP - 1)) {
    await rm(join(base, old.name), { recursive: true, force: true });
  }
}

/** Removes every artifact of a changeset (closed changeset): its preview stops. */
export async function deleteArtifacts(artifactsRoot: string, changesetId: string): Promise<void> {
  await rm(changesetArtifactsDir(artifactsRoot, changesetId), { recursive: true, force: true });
}
