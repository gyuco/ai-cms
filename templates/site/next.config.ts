import path from 'node:path';
import { SECURITY_HEADERS } from '@ai-cms/site-kit/security';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@ai-cms/site-kit', '@ai-cms/content', '@ai-cms/db'],
  // Metadata always blocks and lands in <head>, for every client: streamed metadata would put
  // <title> in <body> until scripts move it, which is invalid HTML (TECHNICAL §11.1).
  htmlLimitedBots: /./,
  poweredByHeader: false,
  // The CSP needs a per-request nonce and is set in proxy.ts; these apply to every response.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: Object.entries(SECURITY_HEADERS).map(([key, value]) => ({ key, value })),
      },
    ];
  },
};

export default config;
