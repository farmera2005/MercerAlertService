import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // Monorepo: trace files from the workspace root so the standalone build includes packages/*.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  transpilePackages: ['@mercer/core', '@mercer/db', '@mercer/swis'],
  serverExternalPackages: ['pg', 'pino', 'pg-boss', 'undici'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Don't write AGENTS.md into the repo on `next dev`.
  agentRules: false,
  // Offline map images (Settings → Map & wall) are uploaded through a server action.
  experimental: { serverActions: { bodySizeLimit: '6mb' } },
  async headers() {
    return [
      {
        // The kiosk token is in the path: never send it to tile servers, never index the page.
        source: '/wall/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'strict-origin' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};

export default config;
