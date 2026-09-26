import type { NextConfig } from 'next';

// Served under /_cms on every site host (see TECHNICAL §10.1).
const config: NextConfig = {
  basePath: '/_cms',
  output: 'standalone',
  transpilePackages: ['@ai-cms/*'],
};

export default config;
