import type { Rule } from 'eslint';
import type { CallExpression, Expression, NewExpression, Node, SpreadElement } from 'estree';

const GLOBALS = new Set(['globalThis', 'window', 'self', 'global']);
const TIMERS = new Set(['setTimeout', 'setInterval']);

/** Name of a global callee: `eval`, `window.eval`, `globalThis['eval']`, … */
function globalName(callee: Node): string | null {
  if (callee.type === 'Identifier') return callee.name;
  if (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    GLOBALS.has(callee.object.name)
  ) {
    if (!callee.computed && callee.property.type === 'Identifier') return callee.property.name;
    if (callee.computed && callee.property.type === 'Literal') return String(callee.property.value);
  }
  return null;
}

function isStringLike(node: Expression | SpreadElement | undefined): boolean {
  if (!node) return false;
  if (node.type === 'Literal') return typeof node.value === 'string';
  if (node.type === 'TemplateLiteral') return true;
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return isStringLike(node.left as Expression) || isStringLike(node.right as Expression);
  }
  return false;
}

export const noEval: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow eval, the Function constructor and string callbacks for setTimeout/setInterval.',
    },
    schema: [],
    messages: {
      eval: 'eval() non è consentito nel codice del sito: esegue codice arbitrario.',
      function:
        'new Function() non è consentito nel codice del sito: esegue codice arbitrario, come eval().',
      timer: '{{name}}() con una stringa esegue codice arbitrario come eval(): passa una funzione.',
    },
  },
  create(context) {
    const checkCall = (node: CallExpression | NewExpression) => {
      const name = globalName(node.callee);
      if (name === 'eval') context.report({ node, messageId: 'eval' });
      else if (name === 'Function') context.report({ node, messageId: 'function' });
      else if (name && TIMERS.has(name) && isStringLike(node.arguments[0])) {
        context.report({ node, messageId: 'timer', data: { name } });
      }
    };
    return { CallExpression: checkCall, NewExpression: checkCall };
  },
};
