import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '@ai-cms/db';
import type { Job } from '@ai-cms/pipeline';
import { afterAll, describe, expect, it } from 'vitest';
import { createHandlers, startupJobs } from './handlers.ts';

describe('site.init handler', () => {
  let dir: string | undefined;

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('runs at startup and creates site.git', async () => {
    expect(startupJobs).toContain('site.init');
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-worker-'));
    const templateDir = join(dir, 'template');
    await mkdir(templateDir);
    await writeFile(join(templateDir, 'package.json'), '{}\n');
    const handlers = createHandlers({} as Database, {
      site: { gitRoot: join(dir, 'git'), workspacesRoot: join(dir, 'ws') },
      templateDir,
    });
    const result = await handlers['site.init']!({}, {} as Job);
    expect(result).toMatchObject({ created: true });
  });
});
