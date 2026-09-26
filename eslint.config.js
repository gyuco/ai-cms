import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
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
);
