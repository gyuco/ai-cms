import { ruleTester } from '../rule-tester.ts';
import { noEval } from './no-eval.ts';

ruleTester.run('no-eval', noEval, {
  valid: [
    { code: 'setTimeout(() => refresh(), 1000);' },
    { code: 'setInterval(tick, 1000);' },
    { code: 'window.setTimeout(function () {}, 10);' },
    { code: 'const handler = "x"; timers.setTimeout(handler);' },
    { code: 'obj.eval("x");' },
    { code: 'const f = () => 1; f();' },
    { code: 'new Map();' },
  ],
  invalid: [
    { code: 'eval("1 + 1");', errors: [{ messageId: 'eval' }] },
    { code: 'eval(code);', errors: [{ messageId: 'eval' }] },
    { code: 'window.eval(code);', errors: [{ messageId: 'eval' }] },
    { code: "globalThis['eval'](code);", errors: [{ messageId: 'eval' }] },
    { code: 'new Function("a", "return a");', errors: [{ messageId: 'function' }] },
    { code: 'Function("return this")();', errors: [{ messageId: 'function' }] },
    { code: 'new globalThis.Function(body);', errors: [{ messageId: 'function' }] },
    {
      code: 'setTimeout("refresh()", 1000);',
      errors: [{ messageId: 'timer', data: { name: 'setTimeout' } }],
    },
    {
      code: 'setInterval(`tick(${n})`, 1000);',
      errors: [{ messageId: 'timer', data: { name: 'setInterval' } }],
    },
    {
      code: 'window.setTimeout("go(" + id + ")", 5);',
      errors: [{ messageId: 'timer', data: { name: 'setTimeout' } }],
    },
    {
      code: 'eval("x");',
      errors: [
        { message: 'eval() non è consentito nel codice del sito: esegue codice arbitrario.' },
      ],
    },
  ],
});
