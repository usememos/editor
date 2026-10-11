// CommonMark 0.31.2 and GFM extension spec examples, rendered through our own
// parser (parseAst + renderAstToHtml) and compared with the reference HTML.
// A per-section summary is printed after the run.

import { afterAll, describe, expect, it } from 'vitest';
import { renderAstToHtml } from '../src/markdown/html';
import { parseAst } from '../src/markdown/parse';
import { type SpecExample, commonmark, gfm } from './fixtures/examples';

/** Sections that must pass completely. */
const REQUIRED = [
  'ATX headings',
  'Setext headings',
  'Paragraphs',
  'Emphasis and strong emphasis',
  'Code spans',
  'Indented code blocks',
  'Fenced code blocks',
  'Lists',
  'List items',
  'Block quotes',
  'Thematic breaks',
  'Backslash escapes',
  'Links',
  'Autolinks',
];

const BLOCK_TAGS =
  'article|blockquote|body|div|dl|dd|dt|h[1-6]|head|hr|html|li|ol|p|pre|section|table|tbody|td|tfoot|th|thead|title|tr|ul';
const reBlockTagSpace = new RegExp(`\\s*(</?(?:${BLOCK_TAGS})(?:\\s[^>]*)?/?>)\\s*`, 'gi');

/**
 * Normalizes HTML the way the spec's test harness (normalize.py) does, as far
 * as it matters here: whitespace next to block-level tags is dropped, and
 * `<br />`-style self-closing tags equal `<br>`. Content inside <pre> is kept.
 */
export function normalizeHtml(html: string): string {
  return html
    .split(/(<pre[\s>][\s\S]*?<\/pre>)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(reBlockTagSpace, '$1').replace(/\s*\/>/g, '>')))
    .join('')
    .trim();
}

function run(name: string, examples: SpecExample[]): void {
  const stats = new Map<string, { pass: number; total: number; failed: number[] }>();
  afterAll(() => {
    let pass = 0;
    let total = 0;
    const lines = [...stats].map(([section, s]) => {
      pass += s.pass;
      total += s.total;
      const failed = s.failed.length ? `  failed: ${s.failed.join(', ')}` : '';
      return `  ${section.padEnd(40)} ${String(s.pass).padStart(3)}/${String(s.total).padEnd(3)}${failed}`;
    });
    console.log(`${name}: ${pass}/${total} (${((100 * pass) / total).toFixed(1)}%)\n${lines.join('\n')}`);
  });

  describe(name, () => {
    for (const ex of examples) {
      const section = ex.extension ? `${ex.section} [${ex.extension}]` : ex.section;
      if (!stats.has(section)) stats.set(section, { pass: 0, total: 0, failed: [] });
      const s = stats.get(section)!;
      s.total++;
      it(`example ${ex.example} (${section})`, () => {
        const actual = renderAstToHtml(parseAst(ex.markdown));
        const ok = normalizeHtml(actual) === normalizeHtml(ex.html);
        if (ok) s.pass++;
        else s.failed.push(ex.example);
        expect(normalizeHtml(actual)).toBe(normalizeHtml(ex.html));
      });
    }
  });
}

run('CommonMark 0.31.2', commonmark);
run('GFM extensions', gfm);

describe('spec coverage targets', () => {
  it('lists the required sections in the fixture', () => {
    const sections = new Set(commonmark.map((e) => e.section));
    for (const s of REQUIRED) expect(sections.has(s), s).toBe(true);
  });
});
