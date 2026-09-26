import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@ai-cms/*'],
};

export default config;
