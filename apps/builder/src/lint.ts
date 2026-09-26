import siteRules from '@ai-cms/eslint-plugin-site';
import tsParser from '@typescript-eslint/parser';
import { ESLint, type Linter } from 'eslint';

/**
 * The lint configuration belongs to the builder, not to the site: the agent cannot weaken it.
 * Only the security rules of TECHNICAL §8.2 run, on every source file of the site.
 */
export const siteLintConfig: Linter.Config[] = [
  { ignores: ['**/node_modules/**', '**/.next/**', 'next-env.d.ts'] },
  {
    ...siteRules.configs.recommended,
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
];

export interface LintOutcome {
  status: 'passed' | 'failed';
  output: string;
}

/**
 * Lints the site in-process. Only parses the code, never runs it: no config file of the site is
 * read (`overrideConfigFile: true`) and `eslint-disable` comments are ignored.
 */
export async function lintSite(siteDir: string): Promise<LintOutcome> {
  const eslint = new ESLint({
    cwd: siteDir,
    overrideConfigFile: true,
    overrideConfig: siteLintConfig,
    allowInlineConfig: false,
    errorOnUnmatchedPattern: false,
  });
  const results = await eslint.lintFiles(['.']);
  const errors = results.reduce((n, r) => n + r.errorCount, 0);
  const warnings = results.reduce((n, r) => n + r.warningCount, 0);
  const formatter = await eslint.loadFormatter('stylish');
  const report = (await formatter.format(results)).replaceAll(`${siteDir}/`, '');
  const files = results.length;
  if (errors > 0) {
    return {
      status: 'failed',
      output: `Regole di sicurezza del sito: ${String(errors)} errori in ${String(files)} file.\n${report}`,
    };
  }
  return {
    status: 'passed',
    output:
      `Regole di sicurezza del sito: nessun errore in ${String(files)} file` +
      (warnings > 0 ? ` (${String(warnings)} avvisi).\n${report}` : '.'),
  };
}
