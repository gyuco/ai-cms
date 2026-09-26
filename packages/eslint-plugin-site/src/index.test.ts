import tsParser from '@typescript-eslint/parser';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import plugin, { configs, rules } from './index.ts';

describe('configs.recommended', () => {
  it('enables every rule as an error', () => {
    expect(configs.recommended.rules).toEqual({
      '@ai-cms/site/no-process-env': 'error',
      '@ai-cms/site/no-dangerous-modules': 'error',
      '@ai-cms/site/no-eval': 'error',
      '@ai-cms/site/no-unapproved-dangerous-html': 'error',
    });
    expect(configs.recommended.plugins?.['@ai-cms/site']).toBe(plugin);
    expect(Object.keys(rules)).toHaveLength(4);
  });

  it('lints generated site code in a flat config', () => {
    const linter = new Linter();
    const code = [
      "import { exec } from 'node:child_process';",
      'const key = process.env.SECRET;',
      'eval(key);',
      'export const Page = () => <div dangerouslySetInnerHTML={{ __html: key }} />;',
    ].join('\n');
    const messages = linter.verify(
      code,
      [
        {
          files: ['**/*.tsx'],
          languageOptions: {
            parser: tsParser,
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
        },
        configs.recommended,
      ],
      'app/page.tsx',
    );
    expect(messages.map((message) => [message.ruleId, message.line])).toEqual([
      ['@ai-cms/site/no-dangerous-modules', 1],
      ['@ai-cms/site/no-process-env', 2],
      ['@ai-cms/site/no-eval', 3],
      ['@ai-cms/site/no-unapproved-dangerous-html', 4],
    ]);
  });
});
