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
};

export default config;
