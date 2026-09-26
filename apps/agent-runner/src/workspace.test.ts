import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveInWorkspace } from './workspace.ts';

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'ws-'));
  root = path.join(base, 'clone');
  outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'app'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, 'app', 'page.tsx'), 'x');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('resolveInWorkspace', () => {
  it('accepts relative and absolute paths inside the clone', async () => {
    expect(await resolveInWorkspace(root, 'app/page.tsx')).toMatchObject({
      rel: 'app/page.tsx',
      exists: true,
    });
    expect(await resolveInWorkspace(root, path.join(root, 'app/new.tsx'))).toMatchObject({
      rel: 'app/new.tsx',
      exists: false,
    });
    expect(await resolveInWorkspace(`${root}/`, '')).toMatchObject({ rel: '' });
    expect(await resolveInWorkspace(root, 'lib/deep/new.ts')).toMatchObject({ exists: false });
  });

  it.each([
    ['../outside/secret.txt', 'outside-workspace'],
    ['app/../../outside/secret.txt', 'outside-workspace'],
    ['/etc/passwd', 'outside-workspace'],
    ['.git/config', 'protected-path'],
    ['.claude/settings.json', 'protected-path'],
  ])('rejects %s', async (input, code) => {
    await expect(resolveInWorkspace(root, input)).rejects.toMatchObject({ code });
  });

  it('rejects absolute paths that climb out', async () => {
    await expect(
      resolveInWorkspace(root, path.join(root, '..', 'outside', 'secret.txt')),
    ).rejects.toMatchObject({ code: 'outside-workspace' });
  });

  it('rejects symlinks that lead outside or into protected directories', async () => {
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await symlink(outside, path.join(root, 'linkdir'));
    await symlink(path.join(root, '.git'), path.join(root, 'gitlink'));
    await expect(resolveInWorkspace(root, 'link.txt')).rejects.toMatchObject({
      code: 'outside-workspace',
    });
    // Also for files that do not exist yet under a symlinked directory.
    await expect(resolveInWorkspace(root, 'linkdir/new.txt')).rejects.toMatchObject({
      code: 'outside-workspace',
    });
    await expect(resolveInWorkspace(root, 'gitlink/config')).rejects.toMatchObject({
      code: 'protected-path',
    });
  });

  it('accepts symlinks that stay inside the clone', async () => {
    await symlink(path.join(root, 'app', 'page.tsx'), path.join(root, 'alias.tsx'));
    expect(await resolveInWorkspace(root, 'alias.tsx')).toMatchObject({ rel: 'alias.tsx' });
  });
});
