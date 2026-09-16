import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingExcludes: {
    '*': [
      './data/**/*',
      './desktop-runtime/**/*',
      './dist-desktop/**/*',
      './tmp/**/*',
      './src/test/**/*',
      './src/**/*.test.ts',
      './src/**/*.test.tsx',
      './src/**/*.spec.ts',
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
