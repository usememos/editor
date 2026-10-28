// @vitest-environment happy-dom
//
// Differential fuzzing: random documents built from Markdown fragments that
// meet at edge cases (delimiters, brackets, HTML, list and quote markers,
// definitions, tabs), compared with commonmark.js and micromark. Only
// documents where both references give the same HTML count: a single
// reference is not reliable (they disagree on about 1% of these documents).
// GFM is not fuzzed here: its second reference, cmark-gfm, is not available
// in Node; the GFM cases are in corpus.json. Documents that micromark's GFM
// extensions read differently (a table, a task item, strikethrough) are
// skipped, because the editor always reads GFM.
//
// Differences already known are listed in fuzz-known.json by their shrunk
// input, with the reason, like known-failures.json.
//
// Every document is checked at the parser layer, and every tenth one in what
// the editor shows. A difference fails the test with the smallest input that
// still shows it; add that input to realistic.json and rebuild the corpus.
//
//   FUZZ_RUNS=200000 FUZZ_SEED=7 npx vitest run packages/editor/test/conformance/fuzz.test.ts

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { micromark } from 'micromark';
import { gfmStrikethrough, gfmStrikethroughHtml } from 'micromark-extension-gfm-strikethrough';
import { gfmTable, gfmTableHtml } from 'micromark-extension-gfm-table';
import { gfmTaskListItem, gfmTaskListItemHtml } from 'micromark-extension-gfm-task-list-item';
import { expect, it } from 'vitest';
import { renderAstToHtml } from '../../src/markdown/html';
import type { MarkdownOptions } from '../../src/markdown/options';
import { parseAst } from '../../src/markdown/parse';
import { canonicalHtml } from './canonical';
import { renderEditor } from './render';

const require = createRequire(import.meta.url);
// commonmark.js ships no types: only the two classes used here.
const commonmark = require('commonmark') as {
  Parser: new () => { parse(markdown: string): unknown };
  HtmlRenderer: new () => { render(tree: unknown): string };
};

const RUNS = Number(process.env.FUZZ_RUNS ?? 20000);
const SEED = Number(process.env.FUZZ_SEED ?? 1);
/** CommonMark only: GFM autolink literals are an extension. */
const OPTIONS: MarkdownOptions = { autolinks: false };

const FRAGMENTS = [
  'foo', 'bar baz', ' ', '  ', '\t', '\n', '\n', '\n\n', '  \n', '\\\n',
  '*', '**', '***', '_', '__', '~', '`', '``', '```', '~~~', '\\', '\\*', '\\[',
  '[', ']', '(', ')', '![', '<', '>', '"', "'", '!', '.', ',', ':', '-', '=', '#', '|', '&', ';',
  '&amp;', '&#35;', '&#x41;', '&copy', '&nbsp;',
  '# ', '## ', '- ', '+ ', '* ', '1. ', '2) ', '> ', '>', '    ', '   ', '---', '***', '===', '___',
  '<div>', '</div>', '<span>', '</span>', '<!--', '-->', '<a href="x">', '</a>', '<br>', '<?', '?>', '<![CDATA[', ']]>', '<pre>', '</pre>',
  '[a]: /u', '[a]: /u "t"', '[a]', '[a][]', '[b][a]', '[a](/v)', '[a](/v "t")', '](', '<http://x.y>', '<a@b.c>', '"t"', "'t'", '(t)',
];

/** mulberry32: a small seeded generator, so a failure replays from its seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const known: Record<string, string> = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fuzz-known.json'), 'utf8'));

/**
 * Families of differences in what the editor shows, accepted as a whole by a
 * pattern on the shrunk input, with the reason as in known-failures.json.
 * The editor parses each HTML block and each inline run on its own (through
 * `sanitizeHtml`), so an element with no closing tag ends there, and an
 * unclosed comment, declaration, CDATA section or processing instruction
 * swallows only its block; a browser reading the references' whole page
 * lets them hold everything after them. A difference in a document with
 * such a tag is not a difference a reader would see elsewhere, so these
 * documents are skipped at the rendered layer.
 */
const ACCEPTED_RENDERED: readonly RegExp[] = [
  // An opening tag with no closing tag for it anywhere after.
  /<([a-z][a-z0-9]*)\b[^<>]*>(?![\s\S]*<\/\1\s*>)/i,
  // A comment, CDATA section, declaration or processing instruction that never ends.
  /<!--(?![\s\S]*-->)|<!\[CDATA\[(?![\s\S]*\]\]>)|<![a-z](?![\s\S]*>)|<\?(?![\s\S]*\?>)/i,
];
const accepted = (layer: string, md: string) => layer === 'rendered' && ACCEPTED_RENDERED.some((re) => re.test(md));

const MICROMARK = { allowDangerousHtml: true, allowDangerousProtocol: true };
const GFM = {
  ...MICROMARK,
  extensions: [gfmStrikethrough(), gfmTable(), gfmTaskListItem()],
  htmlExtensions: [gfmStrikethroughHtml(), gfmTableHtml(), gfmTaskListItemHtml()],
};
const usesGfm = (md: string) => micromark(md, MICROMARK) !== micromark(md, GFM);

const cmReader = new commonmark.Parser();
const cmWriter = new commonmark.HtmlRenderer();
const references = (md: string) => {
  const a = canonicalHtml(cmWriter.render(cmReader.parse(md)));
  const b = canonicalHtml(micromark(md, MICROMARK));
  return a === b ? a : null;
};
const parsed = (md: string) => canonicalHtml(renderAstToHtml(parseAst(md, OPTIONS)));
const shown = (md: string) => canonicalHtml(renderEditor(md, { markdown: OPTIONS }), { alerts: true });

/** Whether `md` is plain CommonMark, the references agree on it, and `ours` differs from them. */
function differs(md: string, ours: (md: string) => string): boolean {
  if (usesGfm(md)) return false;
  const want = references(md);
  return want !== null && ours(md) !== want;
}

/** The smallest input that still differs: drop fragments, then single characters. */
function shrink(parts: string[], ours: (md: string) => string): string {
  for (let i = parts.length - 1; i >= 0; i--) {
    const fewer = [...parts.slice(0, i), ...parts.slice(i + 1)];
    if (fewer.length > 0 && differs(fewer.join(''), ours)) parts = fewer;
  }
  let md = parts.join('');
  for (let i = md.length - 1; i >= 0; i--) {
    const shorter = md.slice(0, i) + md.slice(i + 1);
    if (shorter && differs(shorter, ours)) md = shorter;
  }
  return md;
}

it(`matches commonmark.js and micromark where they agree (${RUNS} documents, seed ${SEED})`, () => {
  const next = random(SEED);
  const found = new Map<string, string>();
  for (let run = 0; run < RUNS && found.size < 20; run++) {
    const parts = Array.from({ length: 1 + Math.floor(next() * 8) }, () => FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]!);
    const md = parts.join('');
    for (const [layer, ours] of [['parser', parsed], ...(run % 10 === 0 ? [['rendered', shown] as const] : [])] as const) {
      if (!differs(md, ours)) continue;
      const small = shrink(parts, ours);
      if (!found.has(small) && !(small in known) && !accepted(layer, small)) found.set(small, `${layer}: ${JSON.stringify(small)}\n  references: ${references(small)}\n  ours:       ${ours(small)}`);
      break;
    }
  }
  expect([...found.values()].join('\n')).toBe('');
}, 600_000);
