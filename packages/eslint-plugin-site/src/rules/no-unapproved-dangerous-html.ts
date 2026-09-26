import type { Rule } from 'eslint';
import type { Node } from 'estree';
import { fileMatches, globsSchema } from '../files.ts';

export const DEFAULT_APPROVED_FILES = ['**/components/approved/**'];

const PROP = 'dangerouslySetInnerHTML';

/** JSX nodes are not part of the ESTree types. */
interface JSXAttribute {
  type: 'JSXAttribute';
  name: { type: string; name?: string };
}

export const noUnapprovedDangerousHtml: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Allow dangerouslySetInnerHTML only in approved components.',
    },
    schema: [
      {
        type: 'object',
        properties: { approvedFiles: globsSchema },
        additionalProperties: false,
      },
    ],
    messages: {
      unapproved:
        'dangerouslySetInnerHTML è consentito solo nei componenti approvati: l’HTML inserito così può contenere script. Usa JSX normale oppure un componente approvato.',
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as { approvedFiles?: string[] };
    if (fileMatches(context, options.approvedFiles ?? DEFAULT_APPROVED_FILES)) return {};
    const report = (node: Node) => context.report({ node, messageId: 'unapproved' });
    return {
      JSXAttribute(node: Rule.Node) {
        const attribute = node as unknown as JSXAttribute;
        if (attribute.name.type === 'JSXIdentifier' && attribute.name.name === PROP) report(node);
      },
      // createElement('div', { dangerouslySetInnerHTML: … }) and spread props objects.
      Property(node) {
        const key = node.key;
        const named =
          (!node.computed && key.type === 'Identifier' && key.name === PROP) ||
          (key.type === 'Literal' && key.value === PROP);
        if (named && node.parent.type === 'ObjectExpression') report(node);
      },
    };
  },
};
