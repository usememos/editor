import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: src('.'),
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      // The more specific path first: aliases match by prefix.
      '@usememos/editor/react': src('../packages/editor/src/react/index.tsx'),
      '@usememos/editor': src('../packages/editor/src/index.ts'),
      // The package's "imports" map points at the build; use the source here.
      '#entities': src('../packages/editor/src/markdown/entities.dom.ts'),
    },
  },
  build: {
    rollupOptions: { input: { main: src('index.html'), react: src('react.html') } },
  },
});
