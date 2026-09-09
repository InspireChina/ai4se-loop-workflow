import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingExcludes: {
    '*': [
      './data/**/*',
      './desktop-runtime/**/*',
      './dist-desktop/**/*',
      './tmp/**/*',
    ],
  },
  outputFileTracingIncludes: {
    '/*': [
      './app-migrations/**/*.sql',
      './migrations/**/*.sql',
    ],
  },
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
};

export default nextConfig;
