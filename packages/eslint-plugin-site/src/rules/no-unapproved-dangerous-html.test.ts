import { ruleTester } from '../rule-tester.ts';
import { noUnapprovedDangerousHtml } from './no-unapproved-dangerous-html.ts';

const error = { messageId: 'unapproved' };
const jsx = 'export const Html = ({ html }) => <div dangerouslySetInnerHTML={{ __html: html }} />;';

ruleTester.run('no-unapproved-dangerous-html', noUnapprovedDangerousHtml, {
  valid: [
    { code: 'export const P = ({ text }) => <p>{text}</p>;', filename: 'app/page.tsx' },
    { code: jsx, filename: 'components/approved/raw-html.tsx' },
    { code: jsx, filename: 'src/components/approved/embed/map.tsx' },
    {
      code: jsx,
      filename: 'lib/trusted/html.tsx',
      options: [{ approvedFiles: ['lib/trusted/**'] }],
    },
    { code: 'const o = { innerHTML: "x" };', filename: 'app/page.tsx' },
  ],
  invalid: [
    { code: jsx, filename: 'app/page.tsx', errors: [error] },
    { code: jsx, filename: 'components/html.tsx', errors: [error] },
    {
      code: jsx,
      filename: 'components/approved/raw-html.tsx',
      options: [{ approvedFiles: ['lib/trusted/**'] }],
      errors: [error],
    },
    {
      code: "createElement('div', { dangerouslySetInnerHTML: { __html: html } });",
      filename: 'app/page.tsx',
      errors: [error],
    },
    {
      code: "const props = { 'dangerouslySetInnerHTML': { __html: html } };",
      filename: 'app/page.tsx',
      errors: [error],
    },
  ],
});
