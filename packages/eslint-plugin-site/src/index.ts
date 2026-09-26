import type { ESLint, Linter, Rule } from 'eslint';
import { noDangerousModules } from './rules/no-dangerous-modules.ts';
import { noEval } from './rules/no-eval.ts';
import { noProcessEnv } from './rules/no-process-env.ts';
import { noUnapprovedDangerousHtml } from './rules/no-unapproved-dangerous-html.ts';

export { DANGEROUS_MODULES, dangerousModule } from './rules/no-dangerous-modules.ts';
export { DEFAULT_CONFIG_FILES } from './rules/no-process-env.ts';
export { DEFAULT_APPROVED_FILES } from './rules/no-unapproved-dangerous-html.ts';

/** Namespace of the rules in a flat config, as ESLint derives it from the package name. */
export const PLUGIN_NAMESPACE = '@ai-cms/site';

export const rules: Record<string, Rule.RuleModule> = {
  'no-process-env': noProcessEnv,
  'no-dangerous-modules': noDangerousModules,
  'no-eval': noEval,
  'no-unapproved-dangerous-html': noUnapprovedDangerousHtml,
};

const plugin = {
  meta: { name: '@ai-cms/eslint-plugin-site', version: '0.0.0' },
  rules,
  configs: {} as Record<'recommended', Linter.Config>,
} satisfies ESLint.Plugin;

/** Flat config enabling every rule as an error; add `files`/parser options in the site config. */
plugin.configs.recommended = {
  name: '@ai-cms/site/recommended',
  plugins: { [PLUGIN_NAMESPACE]: plugin },
  rules: Object.fromEntries(
    Object.keys(rules).map((name) => [`${PLUGIN_NAMESPACE}/${name}`, 'error']),
  ),
};

export const configs = plugin.configs;
export default plugin;
