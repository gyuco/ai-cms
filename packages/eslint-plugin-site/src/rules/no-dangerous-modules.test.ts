import { describe, expect, it } from 'vitest';
import { ruleTester } from '../rule-tester.ts';
import { DANGEROUS_MODULES, dangerousModule, noDangerousModules } from './no-dangerous-modules.ts';

function error(name: string) {
  return { messageId: 'dangerousModule', data: { name } };
}

describe('dangerousModule', () => {
  it('matches every blocked module, with and without the node: prefix', () => {
    for (const name of DANGEROUS_MODULES) {
      expect(dangerousModule(name)).not.toBeNull();
      expect(dangerousModule(`node:${name}`)).not.toBeNull();
    }
  });

  it('matches subpaths but not look-alike packages', () => {
    expect(dangerousModule('fs/promises')).toBe('fs/promises');
    expect(dangerousModule('node:fs/promises')).toBe('fs/promises');
    expect(dangerousModule('fs-extra')).toBeNull();
    expect(dangerousModule('http2')).toBeNull();
    expect(dangerousModule('next/http')).toBeNull();
    expect(dangerousModule('path')).toBeNull();
  });
});

ruleTester.run('no-dangerous-modules', noDangerousModules, {
  valid: [
    { code: "import path from 'node:path';" },
    { code: "import { useState } from 'react';" },
    { code: "import Link from 'next/link';" },
    { code: "import fse from 'fs-extra-like';" },
    { code: "const url = require('node:url');" },
    { code: 'const m = await import(name);' },
    { code: "export { config } from '@site/config';" },
  ],
  invalid: [
    ...DANGEROUS_MODULES.flatMap((name) => [
      { code: `import x from '${name}';`, errors: [error(name)] },
      { code: `import x from 'node:${name}';`, errors: [error(`node:${name}`)] },
    ]),
    { code: "import { readFile } from 'fs/promises';", errors: [error('fs/promises')] },
    { code: "import * as cp from 'node:child_process';", errors: [error('node:child_process')] },
    { code: "import 'net';", errors: [error('net')] },
    { code: "const fs = require('fs');", errors: [error('fs')] },
    { code: 'const cp = require(`child_process`);', errors: [error('child_process')] },
    { code: "require.resolve('vm');", errors: [error('vm')] },
    { code: "const vm = module.require('vm');", errors: [error('vm')] },
    {
      code: "const { exec } = await import('node:child_process');",
      errors: [error('node:child_process')],
    },
    { code: "export { readFileSync } from 'fs';", errors: [error('fs')] },
    { code: "export * from 'node:http';", errors: [error('node:http')] },
    { code: "import fs = require('fs');", errors: [error('fs')] },
    {
      code: "import https from 'https';",
      errors: [
        {
          message:
            'Il modulo "https" non è consentito nel codice del sito: dà accesso a processi, file system o rete. Usa le API del sito (@site/config, i dati del CMS) o un componente approvato.',
        },
      ],
    },
  ],
});
