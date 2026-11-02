import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  outputFileTracingExcludes: {
    '*': [
      './data/**/*',
      './tmp/**/*',
    ],
  },
  outputFileTracingIncludes: {
    '/*': [
      './app-migrations/**/*.sql',
      './migrations/**/*.sql',
      './scripts/omp-rpc.mjs',
      './scripts/omp-extension.mjs',
    ],
  },
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
};

export default nextConfig;
