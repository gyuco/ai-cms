import path from 'node:path';
import type { NextConfig } from 'next';

// Served under /_cms on every site host (see TECHNICAL §10.1).
const config: NextConfig = {
  basePath: '/_cms',
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: [
    '@ai-cms/agents',
    '@ai-cms/ai',
    '@ai-cms/ai-config',
    '@ai-cms/audit',
    '@ai-cms/auth',
    '@ai-cms/authz',
    '@ai-cms/content',
    '@ai-cms/db',
    '@ai-cms/mcp-tools',
    '@ai-cms/pipeline',
    '@ai-cms/site-kit',
    '@ai-cms/tree',
  ],
  serverExternalPackages: ['@node-rs/argon2', 'sharp'],
};

export default config;
