import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The AWS SDK runs only on the server (route handlers); keep it out of client bundles.
  serverExternalPackages: ['@smithy/node-http-handler'],
  images: { remotePatterns: [{ protocol: 'https', hostname: 'cdn.gushwork.ai' }] },
};

export default nextConfig;
