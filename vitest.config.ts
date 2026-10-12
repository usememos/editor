import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The package's "imports" map points at the build; test the source.
  resolve: { alias: { '#entities': fileURLToPath(new URL('packages/editor/src/markdown/entities.ts', import.meta.url)) } },
  test: { include: ['packages/*/test/**/*.test.ts'] },
});
