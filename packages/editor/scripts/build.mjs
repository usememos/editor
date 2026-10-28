// Builds the published package into dist/: ES modules, stylesheets and
// type declarations. Run with `npm run build`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(pkg, 'dist');
const src = (p) => join(pkg, 'src', p);

rmSync(dist, { recursive: true, force: true });

// The published files are minified, with source maps beside them for
// readable stack traces. An app's bundler minifies them again either way;
// minifying here keeps the install small and makes `npm run size` the size
// of the files themselves.
const shared = { bundle: true, format: 'esm', target: 'es2022', minify: true, sourcemap: true, logLevel: 'warning' };

// The core. #entities stays an import so the package's "imports" map picks
// the browser or the Node file, as it does in development.
await build({ ...shared, entryPoints: [src('index.ts')], outfile: join(dist, 'index.js'), external: ['#entities'] });

// The React entry imports the core by package name, so an app that uses both
// gets one copy of the core.
await build({
  ...shared,
  entryPoints: [src('react/index.tsx')],
  outfile: join(dist, 'react.js'),
  jsx: 'automatic',
  external: ['@usememos/editor', 'react', 'react/*', 'react-dom'],
});

// The emoji entry, like the React one, imports the core by package name. Its
// list of emoji is a separate file that it loads on first use.
await build({
  ...shared,
  entryPoints: { emoji: src('emoji/index.ts') },
  outdir: dist,
  splitting: true,
  chunkNames: 'emoji-[name]-[hash]',
  external: ['@usememos/editor'],
});

await build({
  ...shared,
  bundle: false,
  entryPoints: [src('markdown/entities.ts'), src('markdown/entities.dom.ts')],
  outdir: dist,
});

// style.css inlines its two @imports; base.css and theme.css ship on their own too, for apps that import one of them.
for (const file of ['style.css', 'base.css', 'theme.css']) await build({ ...shared, entryPoints: [src(file)], outfile: join(dist, file), sourcemap: false });

execFileSync('npx', ['tsc', '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
addExtensions(join(dist, 'types'));

// npm packs README and LICENSE from the package folder; both live at the repo root.
for (const file of ['README.md', 'LICENSE']) copyFileSync(join(pkg, '../..', file), join(pkg, file));

/**
 * tsc keeps relative imports as written (`./model`). Rewrite them to the
 * files they resolve to (`./model.js`, `./view/index.js`), so the types also
 * load under "moduleResolution": "node16" and "nodenext".
 */
function addExtensions(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      addExtensions(path);
      continue;
    }
    if (!name.endsWith('.d.ts')) continue;
    const text = readFileSync(path, 'utf8').replace(/(from\s+|import\()(['"])(\.{1,2}\/[^'"]*)\2/g, (whole, lead, quote, spec) => {
      const base = join(dirname(path), spec);
      if (existsSync(`${base}.d.ts`)) return `${lead}${quote}${spec}.js${quote}`;
      if (existsSync(join(base, 'index.d.ts'))) return `${lead}${quote}${spec}/index.js${quote}`;
      return whole;
    });
    writeFileSync(path, text);
  }
}
