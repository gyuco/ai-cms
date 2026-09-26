import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintSite } from './lint.ts';

describe('lintSite', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-cms-lint-'));
    await mkdir(join(dir, 'app'));
    await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'eval("1");');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes clean TSX code', async () => {
    await writeFile(
      join(dir, 'app', 'page.tsx'),
      'export default function Page() {\n  return <main><h1>Ciao</h1></main>;\n}\n',
    );
    const result = await lintSite(dir);
    expect(result).toEqual({
      status: 'passed',
      output: 'Regole di sicurezza del sito: nessun errore in 1 file.',
    });
  });

  it('reports the security rules and ignores disable comments and the site config', async () => {
    await writeFile(join(dir, 'eslint.config.js'), 'export default [{ rules: {} }];\n');
    await writeFile(
      join(dir, 'app', 'bad.tsx'),
      [
        '/* eslint-disable */',
        "import { execSync } from 'node:child_process';",
        'export const x = process.env.SEGRETO;',
        'export const y = () => <div dangerouslySetInnerHTML={{ __html: x ?? "" }} />;',
        'export const z = execSync;',
      ].join('\n'),
    );
    const result = await lintSite(dir);
    expect(result.status).toBe('failed');
    expect(result.output).toContain('app/bad.tsx');
    expect(result.output).not.toContain(dir);
    for (const rule of ['no-dangerous-modules', 'no-process-env', 'no-unapproved-dangerous-html']) {
      expect(result.output).toContain(`@ai-cms/site/${rule}`);
    }
    expect(result.output).not.toContain('node_modules');
  });
});
