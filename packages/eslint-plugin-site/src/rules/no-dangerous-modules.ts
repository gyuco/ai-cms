import type { Rule } from 'eslint';
import type { Node } from 'estree';

/** Node.js modules the generated site must not use (TECHNICAL §8.2, FR-110/111). */
export const DANGEROUS_MODULES = [
  'child_process',
  'fs',
  'fs/promises',
  'vm',
  'worker_threads',
  'cluster',
  'net',
  'dgram',
  'http',
  'https',
];

const blocked = new Set(DANGEROUS_MODULES);

/** Returns the blocked module name for a specifier, or null. Covers `node:` and subpaths. */
export function dangerousModule(specifier: string): string | null {
  const name = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  if (blocked.has(name)) return name;
  const base = name.split('/')[0] ?? name;
  return blocked.has(base) ? base : null;
}

function staticString(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** TypeScript `import fs = require('fs')`, which is not part of ESTree. */
interface TSImportEqualsDeclaration {
  type: 'TSImportEqualsDeclaration';
  moduleReference: { type: string; expression?: Node };
}

export const noDangerousModules: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Node.js modules that give access to processes, the file system or the network.',
    },
    schema: [],
    messages: {
      dangerousModule:
        'Il modulo "{{name}}" non è consentito nel codice del sito: dà accesso a processi, file system o rete. Usa le API del sito (@site/config, i dati del CMS) o un componente approvato.',
    },
  },
  create(context) {
    const check = (node: Node, source: Node | null | undefined) => {
      const specifier = staticString(source);
      if (specifier !== null && dangerousModule(specifier) !== null) {
        context.report({ node, messageId: 'dangerousModule', data: { name: specifier } });
      }
    };
    return {
      ImportDeclaration(node) {
        check(node, node.source);
      },
      ExportNamedDeclaration(node) {
        check(node, node.source);
      },
      ExportAllDeclaration(node) {
        check(node, node.source);
      },
      ImportExpression(node) {
        check(node, node.source);
      },
      CallExpression(node) {
        const callee = node.callee;
        const isRequire =
          (callee.type === 'Identifier' && callee.name === 'require') ||
          // require.resolve / module.require
          (callee.type === 'MemberExpression' &&
            !callee.computed &&
            callee.property.type === 'Identifier' &&
            ((callee.object.type === 'Identifier' &&
              callee.object.name === 'require' &&
              callee.property.name === 'resolve') ||
              (callee.object.type === 'Identifier' &&
                callee.object.name === 'module' &&
                callee.property.name === 'require')));
        const [first] = node.arguments;
        if (isRequire && first && first.type !== 'SpreadElement') check(node, first);
      },
      TSImportEqualsDeclaration(node: Rule.Node) {
        const declaration = node as unknown as TSImportEqualsDeclaration;
        if (declaration.moduleReference.type === 'TSExternalModuleReference') {
          check(node, declaration.moduleReference.expression);
        }
      },
    };
  },
};
