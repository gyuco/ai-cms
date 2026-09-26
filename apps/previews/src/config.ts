import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import {
  isChangesetId,
  isCommitId,
  PREVIEW_ENV_KEYS,
  type PreviewConfig,
} from '@ai-cms/pipeline/builder';

/**
 * `cs-<changeset id>.localhost` → the changeset id. Anything else (other hosts, malformed or
 * uppercase-only variations that are not a valid id) → null.
 */
export function changesetIdFromHost(
  host: string | undefined,
  suffix = '.localhost',
): string | null {
  if (!host) return null;
  const name = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!name.startsWith('cs-') || !name.endsWith(suffix)) return null;
  const id = name.slice(3, name.length - suffix.length);
  return isChangesetId(id) ? id : null;
}

const isRelativeInside = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length > 0 &&
  !isAbsolute(path) &&
  !normalize(path).startsWith('..') &&
  !path.includes('\0');

/**
 * Reads `<artifactsRoot>/<id>/preview.json`. The builder writes it, but site code runs in the
 * builder too, so the file is validated like untrusted input: paths stay inside the changeset
 * directory and only the allowed environment variables are kept.
 */
export async function readPreviewConfig(
  artifactsRoot: string,
  changesetId: string,
): Promise<PreviewConfig | null> {
  if (!isChangesetId(changesetId)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(artifactsRoot, changesetId, 'preview.json'), 'utf8'));
  } catch {
    return null;
  }
  const c = (raw ?? {}) as Record<string, unknown>;
  if (c.changesetId !== changesetId || !isCommitId(c.commit)) return null;
  if (!isRelativeInside(c.artifact) || c.artifact.includes('/')) return null;
  if (!isRelativeInside(c.server) || !c.server.endsWith('.js')) return null;
  const env: Record<string, string> = {};
  const source = (c.env ?? {}) as Record<string, unknown>;
  for (const key of PREVIEW_ENV_KEYS) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }
  return {
    changesetId,
    commit: c.commit,
    artifact: c.artifact,
    server: c.server,
    env,
    builtAt: typeof c.builtAt === 'string' ? c.builtAt : '',
  };
}
