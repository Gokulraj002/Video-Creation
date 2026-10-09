import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // `@vc/schema` is consumed as TypeScript source (no build step).
  transpilePackages: ['@vc/schema'],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
