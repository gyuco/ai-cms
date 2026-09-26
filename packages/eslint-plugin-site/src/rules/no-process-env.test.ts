import { ruleTester } from '../rule-tester.ts';
import { noProcessEnv } from './no-process-env.ts';

const error = { messageId: 'noProcessEnv' };

ruleTester.run('no-process-env', noProcessEnv, {
  valid: [
    { code: "import { config } from '@site/config';\nconst url = config.apiUrl;" },
    { code: 'const cwd = process.cwd();' },
    { code: 'const env = { mode: "prod" }; env.mode;' },
    { code: 'const value = process.env.API_URL;', filename: 'src/config/index.ts' },
    { code: 'const { env } = process;', filename: 'config/server.ts' },
    { code: 'export default { url: process.env.URL };', filename: 'site.config.ts' },
    {
      code: 'const value = process.env.API_URL;',
      filename: 'lib/settings.ts',
      options: [{ allowedFiles: ['lib/settings.ts'] }],
    },
  ],
  invalid: [
    { code: 'const url = process.env.API_URL;', filename: 'app/page.tsx', errors: [error] },
    { code: "const url = process.env['API_URL'];", errors: [error] },
    { code: "const url = process['env'].API_URL;", errors: [error] },
    { code: 'const url = globalThis.process.env.API_URL;', errors: [error] },
    { code: 'const { env } = process;', errors: [error] },
    { code: 'const { env: variables } = globalThis.process;', errors: [error] },
    { code: "import { env } from 'node:process';", errors: [error] },
    { code: "import { env as e } from 'process';", errors: [error] },
    {
      code: 'const value = process.env.API_URL;',
      filename: 'src/config/index.ts',
      options: [{ allowedFiles: ['lib/settings.ts'] }],
      errors: [error],
    },
    {
      code: 'const url = process.env.API_URL;',
      errors: [
        {
          message:
            'Non leggere process.env direttamente: importa la configurazione da @site/config, l’unico modulo autorizzato a leggere variabili d’ambiente e segreti.',
        },
      ],
    },
  ],
});
