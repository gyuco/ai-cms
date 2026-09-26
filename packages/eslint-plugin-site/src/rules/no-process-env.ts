import type { Rule } from 'eslint';
import type { Node } from 'estree';
import { fileMatches, globsSchema } from '../files.ts';

export const DEFAULT_CONFIG_FILES = ['**/config/**', '**/site.config.*'];

const PROCESS_MODULES = new Set(['process', 'node:process']);

function isIdentifier(node: Node | null | undefined, name: string): boolean {
  return node?.type === 'Identifier' && node.name === name;
}

function isEnvKey(node: Node, computed: boolean): boolean {
  if (!computed) return isIdentifier(node, 'env');
  return node.type === 'Literal' && node.value === 'env';
}

/** `process`, `globalThis.process` or `global.process`. */
function isProcess(node: Node): boolean {
  if (isIdentifier(node, 'process')) return true;
  return (
    node.type === 'MemberExpression' &&
    (isIdentifier(node.object, 'globalThis') || isIdentifier(node.object, 'global')) &&
    !node.computed &&
    isIdentifier(node.property, 'process')
  );
}

export const noProcessEnv: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow reading process.env outside the site configuration module.',
    },
    schema: [
      {
        type: 'object',
        properties: { allowedFiles: globsSchema },
        additionalProperties: false,
      },
    ],
    messages: {
      noProcessEnv:
        'Non leggere process.env direttamente: importa la configurazione da @site/config, l’unico modulo autorizzato a leggere variabili d’ambiente e segreti.',
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as { allowedFiles?: string[] };
    if (fileMatches(context, options.allowedFiles ?? DEFAULT_CONFIG_FILES)) return {};
    const report = (node: Node) => context.report({ node, messageId: 'noProcessEnv' });
    return {
      MemberExpression(node) {
        if (isProcess(node.object) && isEnvKey(node.property, node.computed)) report(node);
      },
      // const { env } = process
      VariableDeclarator(node) {
        if (!node.init || !isProcess(node.init) || node.id.type !== 'ObjectPattern') return;
        for (const property of node.id.properties) {
          if (property.type === 'Property' && isEnvKey(property.key, property.computed)) {
            report(property);
          }
        }
      },
      // import { env } from 'node:process'
      ImportDeclaration(node) {
        if (!PROCESS_MODULES.has(String(node.source.value))) return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ImportSpecifier' &&
            (isIdentifier(specifier.imported, 'env') ||
              (specifier.imported.type === 'Literal' && specifier.imported.value === 'env'))
          ) {
            report(specifier);
          }
        }
      },
    };
  },
};
