import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // The package's "imports" map points at the build; test the source.
  resolve: { alias: { '#entities': fileURLToPath(new URL('packages/editor/src/markdown/entities.ts', import.meta.url)) } },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The timing suite runs alone (`npm run test:timing`): other test files running in parallel skew its timings.
    exclude: process.env.MBE_TIMING ? configDefaults.exclude : [...configDefaults.exclude, '**/timing.test.ts'],
  },
});
