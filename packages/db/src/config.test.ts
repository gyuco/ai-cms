import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appDatabaseUrl } from './config.ts';

describe('appDatabaseUrl', () => {
  let dir: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('builds the URL from the host variable and the role secret', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-secrets-'));
    await writeFile(join(dir, 'pg_staging_owner'), 'p@ss/word\n');
    vi.stubEnv('SECRETS_DIR', dir);
    vi.stubEnv('STAGING_DB_HOST', 'postgres-staging');
    expect(appDatabaseUrl('staging', 'owner')).toBe(
      'postgres://app_owner:p%40ss%2Fword@postgres-staging:5432/app_staging',
    );
    expect(appDatabaseUrl('staging', 'owner', 'postgres')).toMatch(/\/postgres$/);
  });
});
