import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: src('.'),
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@editor/core': src('../packages/core/src/index.ts'),
      '@editor/react': src('../packages/react/src/index.tsx'),
    },
  },
  build: {
    rollupOptions: { input: { main: src('index.html'), react: src('react.html') } },
  },
});
