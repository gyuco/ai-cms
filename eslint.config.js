import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.claude/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // Single point of DB access (TECHNICAL §6.8): everything else goes through services that
  // call authz.
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    ignores: [
      'packages/db/**',
      'packages/tree/**',
      'packages/content/**',
      'packages/pipeline/**',
      'packages/auth/**',
      'packages/audit/**',
      'packages/ai-config/**',
      'packages/site-kit/**',
      'apps/cms-api/lib/**',
      'apps/cms-api/cli/**',
      'apps/worker/**',
      '**/*.test.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@ai-cms/db', '@ai-cms/db/*'],
              message:
                'Do not access the database directly: use the services (tree, content, pipeline, auth, audit) that go through authz, or apps/cms-api/lib.',
            },
          ],
        },
      ],
    },
  },
);
