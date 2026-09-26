import path from 'node:path';
import type { NextConfig } from 'next';

// Served under /_cms on every site host (see TECHNICAL §10.1).
const config: NextConfig = {
  basePath: '/_cms',
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@ai-cms/db'],
};

export default config;
