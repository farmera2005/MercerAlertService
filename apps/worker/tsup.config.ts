import { defineConfig } from 'tsup';

// Bundle the workspace packages (they ship TS source); keep npm deps external.
export default defineConfig({
  // discover: lets ops run `docker compose run --rm --no-deps worker node dist/discover.js` on the VM.
  entry: {
    index: 'src/index.ts',
    migrate: 'src/migrate-cli.ts',
    init: 'src/init-cli.ts',
    account: 'src/account-cli.ts',
    discover: '../../scripts/swis-discover.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@mercer\//],
  external: ['pg-native'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
