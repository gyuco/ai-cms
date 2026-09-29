import { describe, expect, it } from 'vitest';
import {
  ManifestError,
  parseManifest,
  resolveRepoFileForTreePath,
  resolveTreePathForFile,
  type Manifest,
} from './manifest.ts';

const TEMPLATE_MANIFEST = {
  version: 1,
  rules: [
    { tree: '/site/pages/{path}/page.tsx', repo: 'app/(dynamic)/{path}/page.tsx' },
    { tree: '/site/components/{path}', repo: 'components/{path}' },
    { tree: '/code/api/{path}', repo: 'api/{path}' },
    { tree: '/code/lib/{path}', repo: 'lib/{path}' },
    { tree: '/code/migrations/{path}', repo: 'db/migrations/{path}' },
    { tree: '/data/collections/{name}/schema', repo: 'db/schema/{name}.ts' },
  ],
  files: [],
};

describe('parseManifest', () => {
  it('accepts the site template manifest', () => {
    const manifest = parseManifest(TEMPLATE_MANIFEST);
    expect(manifest.rules).toHaveLength(6);
    expect(manifest.files).toEqual([]);
  });

  it('defaults "files" to an empty array', () => {
    const manifest = parseManifest({ version: 1, rules: [] });
    expect(manifest.files).toEqual([]);
  });

  it.each([
    [null, 'un oggetto'],
    [{ version: 2, rules: [] }, 'versione'],
    [{ version: 1, rules: 'nope' }, 'rules'],
    [{ version: 1, rules: [], files: 'nope' }, 'files'],
    [{ version: 1, rules: [{ tree: '/a', repo: 'a' }] }, 'segnaposto'],
    [{ version: 1, rules: [{ tree: '/a/{x}/{y}', repo: 'a/{x}' }] }, 'un solo segnaposto'],
    [{ version: 1, rules: [{ tree: '/a/{}', repo: 'a/{x}' }] }, 'vuoto'],
    [{ version: 1, rules: [], files: [{ tree: '/a/{x}', repo: 'a' }] }, 'segnaposto'],
  ])('rejects %j', (input, message) => {
    expect(() => parseManifest(input)).toThrow(ManifestError);
    expect(() => parseManifest(input)).toThrow(new RegExp(message));
  });
});

describe('resolveTreePathForFile', () => {
  const manifest: Manifest = parseManifest(TEMPLATE_MANIFEST);

  it.each([
    [
      'app/(dynamic)/catalogo/page.tsx',
      { path: '/site/pages/catalogo/page.tsx', requiredAncestor: '/site/pages/catalogo' },
    ],
    [
      'components/ui/button.tsx',
      { path: '/site/components/ui/button.tsx', requiredAncestor: '/site/components' },
    ],
    ['api/contatti.ts', { path: '/code/api/contatti.ts', requiredAncestor: '/code/api' }],
    ['lib/prezzi.ts', { path: '/code/lib/prezzi.ts', requiredAncestor: '/code/lib' }],
    [
      'db/migrations/0001_init.sql',
      { path: '/code/migrations/0001_init.sql', requiredAncestor: '/code/migrations' },
    ],
    [
      'db/schema/prodotti.ts',
      { path: '/data/collections/prodotti/schema', requiredAncestor: '/data/collections/prodotti' },
    ],
  ])('%s → %j', (file, expected) => {
    expect(resolveTreePathForFile(manifest, file)).toEqual(expected);
  });

  it('returns null for files with no matching rule', () => {
    expect(resolveTreePathForFile(manifest, 'package.json')).toBeNull();
    expect(resolveTreePathForFile(manifest, 'next.config.ts')).toBeNull();
  });

  it('prefers an explicit file mapping over a rule', () => {
    const withOverride = parseManifest({
      ...TEMPLATE_MANIFEST,
      files: [{ tree: '/site/layouts/default', repo: 'app/layout.tsx' }],
    });
    expect(resolveTreePathForFile(withOverride, 'app/layout.tsx')).toEqual({
      path: '/site/layouts/default',
      requiredAncestor: '/site/layouts',
    });
  });
});

describe('resolveRepoFileForTreePath', () => {
  const manifest: Manifest = parseManifest(TEMPLATE_MANIFEST);

  it('is the inverse of resolveTreePathForFile for rule-based matches', () => {
    const files = [
      'app/(dynamic)/catalogo/page.tsx',
      'components/ui/button.tsx',
      'api/contatti.ts',
      'lib/prezzi.ts',
      'db/migrations/0001_init.sql',
      'db/schema/prodotti.ts',
    ];
    for (const file of files) {
      const match = resolveTreePathForFile(manifest, file)!;
      expect(resolveRepoFileForTreePath(manifest, match.path)).toBe(file);
    }
  });

  it('returns null when nothing matches', () => {
    expect(resolveRepoFileForTreePath(manifest, '/site/settings')).toBeNull();
  });
});
