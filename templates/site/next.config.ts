import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@ai-cms/site-kit', '@ai-cms/content', '@ai-cms/db'],
  // Metadata always blocks and lands in <head>, for every client: streamed metadata would put
  // <title> in <body> until scripts move it, which is invalid HTML (TECHNICAL §11.1).
  htmlLimitedBots: /./,
};

export default config;
