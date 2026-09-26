import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The pre-receive hook of site.git (MVP1 E10.3). `initSiteRepo` installs it;
 * `docker/git/hooks/pre-receive` is an identical copy (a test keeps them in sync).
 *
 * The pusher declares itself with CMS_GIT_ACTOR, set only by the worker:
 * - `changeset`: only `refs/heads/cs/*`, never deleted;
 * - `release`: only `main`, `staging` and `release-*` tags, never deleted;
 * - anything else, including a missing variable, is refused.
 * Per-file permission checks arrive in phase 2 (TECHNICAL §6.6).
 */
export const PRE_RECEIVE_HOOK = `#!/bin/sh
# AI-CMS: branch protection for site.git (TECHNICAL 6.6, MVP1 E10.3).
# Generated from packages/pipeline/src/pre-receive.ts: edit it there.
actor="\${CMS_GIT_ACTOR:-}"
status=0

refuse() {
  echo "ai-cms: push rifiutato su $1: $2" >&2
  status=1
}

is_zero() {
  case "$1" in
    *[!0]*) return 1 ;;
    *) return 0 ;;
  esac
}

while read -r old new ref; do
  : "$old"
  case "$actor" in
    changeset)
      case "$ref" in
        refs/heads/cs/?*)
          if is_zero "$new"; then
            refuse "$ref" "i rami dei changeset non si possono eliminare con un push"
          fi
          ;;
        *) refuse "$ref" "un changeset puo' aggiornare solo i rami cs/*" ;;
      esac
      ;;
    release)
      case "$ref" in
        refs/heads/main | refs/heads/staging | refs/tags/release-?*)
          if is_zero "$new"; then
            refuse "$ref" "i rami e i tag di release non si possono eliminare"
          fi
          ;;
        *) refuse "$ref" "una release puo' aggiornare solo main, staging e i tag release-*" ;;
      esac
      ;;
    *)
      refuse "$ref" "solo il worker della piattaforma puo' scrivere in questo repository (CMS_GIT_ACTOR mancante o non valido)"
      ;;
  esac
done

exit $status
`;

/** Writes the hook into a bare repository, replacing any previous version atomically. */
export async function installPreReceiveHook(bareRepo: string): Promise<void> {
  const hooks = join(bareRepo, 'hooks');
  await mkdir(hooks, { recursive: true });
  const target = join(hooks, 'pre-receive');
  const temp = `${target}.tmp-${process.pid}`;
  await writeFile(temp, PRE_RECEIVE_HOOK);
  await chmod(temp, 0o755);
  await rename(temp, target);
}
