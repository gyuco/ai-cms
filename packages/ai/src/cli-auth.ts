import { stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Per-user CLI profiles (TECHNICAL §7.4), kept consistent with `docker/images/cms-connect`,
 * which creates them and runs the official login.
 */

/** Same rule as CMS usernames; it also keeps the profile path inside the root. */
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;

/** `CLAUDE_CONFIG_DIR` of a user: `<cliAuthRoot>/<username>/claude`. */
export function claudeCodeConfigDir(cliAuthRoot: string, username: string): string {
  if (!USERNAME.test(username)) throw new Error(`Invalid username for a CLI profile: ${username}`);
  return path.join(cliAuthRoot, username, 'claude');
}

/**
 * Whether the user has logged in to Claude Code in this profile. It only checks that the
 * credentials file exists and is not empty: its content is never read (FR-126).
 */
export async function hasClaudeCodeLogin(configDir: string): Promise<boolean> {
  try {
    const info = await stat(path.join(configDir, '.credentials.json'));
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
