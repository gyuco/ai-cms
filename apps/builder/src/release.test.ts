import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReleaseArtifact,
  ReleaseBuildError,
  parseReleaseRequest,
  type ReleaseBuildConfig,
  type ReleaseBuildTools,
} from './release.ts';

const request = {
  releaseId: '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  changesetId: '0b5c7a4e-9d1f-4c3a-8e2b-1f2a3b4c5d6e',
  commit: 'a'.repeat(40),
};

describe('parseReleaseRequest', () => {
  it('accepts a valid request and names the invalid field otherwise', () => {
    expect(parseReleaseRequest(request)).toEqual(request);
    expect(parseReleaseRequest({ ...request, releaseId: '../x' })).toBe('releaseId non valido');
    expect(parseReleaseRequest({ ...request, commit: 'HEAD' })).toBe('commit non valido');
    expect(parseReleaseRequest(null)).toBe('releaseId non valido');
  });
});

describe('buildReleaseArtifact', () => {
  let dir: string;
  let config: ReleaseBuildConfig;
  let calls: string[];

  const tools = (
    overrides: Partial<Record<'install' | 'build', number>> = {},
  ): ReleaseBuildTools => ({
    exec: async (command, args) => {
      calls.push(`${command.split('/').pop()} ${args[0] ?? ''}`.trim());
      const code = (command === 'pnpm' ? overrides.install : overrides.build) ?? 0;
      return { code, output: code ? 'errore di prova' : 'ok', timedOut: false };
    },
    prepare: async () => {
      const work = await mkdtemp(join(dir, 'run-'));
      return { dir: work, repo: join(work, 'repo'), site: join(work, 'repo', 'site'), home: work };
    },
    assemble: async (_options, dest) => {
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, 'server.js'), '// server\n');
      return 'server.js';
    },
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-release-'));
    calls = [];
    config = {
      platformRoot: dir,
      workRoot: join(dir, 'work'),
      workspacesRoot: join(dir, 'workspaces'),
      releasesRoot: join(dir, 'releases'),
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('builds the artifact into releases/<id> with the server file', async () => {
    const result = await buildReleaseArtifact(request, config, tools());
    expect(result).toEqual({
      releaseId: request.releaseId,
      commit: request.commit,
      server: 'server.js',
    });
    expect(calls).toEqual(['pnpm install', 'next build']);
    const artifact = join(config.releasesRoot, request.releaseId);
    expect((await readFile(join(artifact, 'SERVER'), 'utf8')).trim()).toBe('server.js');
    expect(JSON.parse(await readFile(join(artifact, 'release.json'), 'utf8'))).toMatchObject({
      releaseId: request.releaseId,
      commit: request.commit,
    });
    // No temporary directory is left next to the artifact.
    expect(await readdir(config.releasesRoot)).toEqual([request.releaseId]);
  });

  it('leaves no artifact when the build fails', async () => {
    await expect(buildReleaseArtifact(request, config, tools({ build: 1 }))).rejects.toThrow(
      ReleaseBuildError,
    );
    await expect(access(join(config.releasesRoot, request.releaseId))).rejects.toThrow();
    expect(await readdir(config.releasesRoot)).toEqual([]);
  });

  it('reports a failed install', async () => {
    await expect(buildReleaseArtifact(request, config, tools({ install: 1 }))).rejects.toThrow(
      /Installazione/,
    );
  });
});
