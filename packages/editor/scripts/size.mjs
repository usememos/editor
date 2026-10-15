// Prints how much the published files add to an app: each entry bundled
// for browsers as an app's bundler would, minified, then gzipped. There is
// no limit; see "Performance" in docs/architecture.md. Run `npm run size`,
// which builds dist/ first.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(pkg, 'dist');

const entries = [
  ['Core, `Editor` only', "import { Editor } from '@usememos/editor'; new Editor({ element: document.body });"],
  ['Core, every export', "export * from '@usememos/editor';"],
  ['React entry, on top of the core', "export * from '@usememos/editor/react';", ['@usememos/editor', 'react', 'react/*', 'react-dom']],
  // The emoji list is a separate file, loaded the first time the popup opens.
  ['Emoji entry, on top of the core', "export * from '@usememos/editor/emoji';", ['@usememos/editor', './emoji-data-*']],
  ['Emoji list, loaded on first use', `export * from './dist/${readdirSync(dist).find((f) => /^emoji-data-.*\.js$/.test(f))}';`],
];

const kb = (bytes) => `${(bytes / 1000).toFixed(1)} KB`;
const rows = [];
for (const [name, contents, external = []] of entries) {
  const result = await build({
    stdin: { contents, resolveDir: pkg, loader: 'js' },
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    external,
    // The built files, with #entities resolved through the package's
    // imports map as in an app, not through the repo's tsconfig paths.
    alias: external.length
      ? { '@usememos/editor/react': join(dist, 'react.js'), '@usememos/editor/emoji': join(dist, 'emoji.js') }
      : { '@usememos/editor': join(dist, 'index.js') },
    tsconfigRaw: {},
    logLevel: 'warning',
  });
  const code = result.outputFiles[0].contents;
  rows.push([name, kb(code.length), kb(gzipSync(code, { level: 9 }).length)]);
}
const css = readFileSync(join(dist, 'style.css'));
rows.push(['`style.css`', kb(css.length), kb(gzipSync(css, { level: 9 }).length)]);

console.log('| Entry | Minified | Minified and gzipped |\n| --- | --- | --- |');
for (const row of rows) console.log(`| ${row.join(' | ')} |`);
