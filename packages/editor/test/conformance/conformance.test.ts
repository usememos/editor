// @vitest-environment happy-dom
//
// Every case in corpus.json (see scripts/conformance.mjs), checked against
// what popular renderers give for it, never against the editor's own output:
//
// - the HTML github.com rendered, where the case has it;
// - otherwise cmark-gfm (GitHub's parser) when micromark with the GFM
//   extensions agrees with it;
// - otherwise micromark when commonmark.js agrees with it: cmark-gfm follows
//   CommonMark 0.29, and where 0.31.2 changed the rules, the editor follows
//   0.31.2, as micromark and commonmark.js do;
// - otherwise the renderers disagree, and the case has no expected result.
//   It is listed as a todo.
//
// Two layers are checked: the parser (the AST rendered by html.ts), and what
// the editor shows (its DOM read back by render.ts). HTML is compared in the
// canonical form of canonical.ts, which drops differences a reader cannot see.
//
// A third layer checks that saving keeps what the reader sees: every block
// is written by the serializer, as when all of them were edited, and the
// saved Markdown must show the same as the original. The rendered layer
// ties what the original shows to the references, so this one compares with
// it, and runs for the cases whose references disagree too.
//
// Cases in known-failures.json are expected to fail (it.fails), with the
// reason. When one starts passing, its test fails: remove it from the list.
// A reason starts with "bug" (to fix) or "accepted" (a difference kept on
// purpose, with why in parentheses).
//
// A fourth layer checks what the editor shows in the memos dialect (line
// breaks, no setext headings) against the old memos pipeline (micromark with
// remark-breaks and setext disabled), for the cases where the dialect changes
// the result and micromark gives the expected result in the default dialect.
//
// A fifth layer checks that the saved Markdown reads the same in another
// renderer: micromark with the GFM extensions renders the saved form of
// each case (every block written by the serializer) as it renders the
// original, where micromark gives the expected result for the original.
//
// CONFORMANCE_REPORT=<file> writes each failure's input and both outputs.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { micromark } from 'micromark';
import { gfmAutolinkLiteral, gfmAutolinkLiteralHtml } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough, gfmStrikethroughHtml } from 'micromark-extension-gfm-strikethrough';
import { gfmTable, gfmTableHtml } from 'micromark-extension-gfm-table';
import { gfmTaskListItem, gfmTaskListItemHtml } from 'micromark-extension-gfm-task-list-item';
import { afterAll, describe, expect, it } from 'vitest';
import { renderAstToHtml } from '../../src/markdown/html';
import type { MarkdownOptions } from '../../src/markdown/options';
import { parseAst, parseMarkdown } from '../../src/markdown/parse';
import { serializeMarkdown } from '../../src/markdown/serialize';
import { canonicalHtml } from './canonical';
import { renderEditor } from './render';

interface Case {
  id: string;
  section: string;
  markdown: string;
  also: string[];
  extension?: string;
  breaks?: boolean;
  spec?: string;
  github?: string;
  cmarkGfm: string | null;
  micromark?: string;
  commonmark?: string;
  markdownIt?: string;
  memos?: string;
}

type Layer = 'parser' | 'rendered' | 'saved' | 'memos' | 'elsewhere';

// Not `new URL(…, import.meta.url)`: happy-dom replaces URL with one that has no file scheme.
const dir = dirname(fileURLToPath(import.meta.url));
const corpus: { cases: Case[] } = JSON.parse(readFileSync(join(dir, 'corpus.json'), 'utf8'));
const known: Record<Layer, Record<string, string>> = JSON.parse(readFileSync(join(dir, 'known-failures.json'), 'utf8'));

const output = (c: Case, key: 'micromark' | 'commonmark' | 'markdownIt') => (c[key] === '=cmarkGfm' ? c.cmarkGfm : c[key]);

/** Suites whose own expected HTML follows CommonMark 0.31.2. */
const SUITES_0_31 = ['commonmark', 'commonmark.js-regression', 'markdown-it-commonmark-extras'];

/** The expected HTML and where it comes from, or null where the references disagree. */
export function expected(c: Case): { html: string; from: string } | null {
  if (c.github !== undefined) return { html: c.github, from: 'github.com' };
  const micromark = output(c, 'micromark');
  if (c.cmarkGfm === null || micromark === undefined || micromark === null) return null;
  if (canonicalHtml(c.cmarkGfm) === canonicalHtml(micromark)) return { html: c.cmarkGfm, from: 'cmark-gfm and micromark' };
  // cmark-gfm follows CommonMark 0.29; micromark and commonmark.js follow 0.31.2, which wins. Both are
  // JavaScript and share some mistakes (non-BMP punctuation), so a 0.31.2 suite's own result must agree too.
  const commonmark = output(c, 'commonmark');
  const own = SUITES_0_31.some((suite) => c.id.startsWith(`${suite}#`)) ? c.spec : undefined;
  const html = canonicalHtml(micromark);
  if (commonmark && canonicalHtml(commonmark) === html && (own === undefined || canonicalHtml(own) === html)) {
    return { html: micromark, from: 'CommonMark 0.31.2 (micromark and commonmark.js)' };
  }
  return null;
}

const failures: { layer: Layer; id: string; from: string; markdown: string; expected: string; actual: string }[] = [];
afterAll(() => {
  const file = process.env.CONFORMANCE_REPORT;
  if (file) writeFileSync(file, JSON.stringify(failures, null, 1));
});

function check(layer: Layer, render: (c: Case, options: MarkdownOptions) => string): void {
  describe(layer, () => {
    for (const c of corpus.cases) {
      const name = `${c.id} (${c.section})`;
      const want = expected(c);
      if (!want) {
        it.todo(`${name}: renderers disagree`);
        continue;
      }
      // The AST has no line break mode: html.ts writes a soft break as a newline. What the editor shows covers it.
      if (layer === 'parser' && c.breaks) continue;
      const reason = known[layer][c.id];
      (reason ? it.fails : it)(reason ? `${name}: ${reason}` : name, () => {
        const options: MarkdownOptions = c.breaks ? { breaks: true } : {};
        // The parser has no alerts: lowering makes callouts.
        const alerts = layer === 'rendered';
        const actual = canonicalHtml(render(c, options), { alerts });
        const html = canonicalHtml(want.html, { alerts });
        if (actual !== html) failures.push({ layer, id: c.id, from: want.from, markdown: c.markdown, expected: html, actual });
        expect(actual, `expected from ${want.from}`).toBe(html);
      });
    }
  });
}

check('parser', (c, options) => renderAstToHtml(parseAst(c.markdown, options)));
check('rendered', (c, options) => renderEditor(c.markdown, { markdown: options }));

/** memos' dialect, without its syntax extensions. */
const MEMO: MarkdownOptions = { breaks: true, setext: false };

describe('memos', () => {
  for (const c of corpus.cases) {
    if (c.breaks || c.memos === undefined) continue;
    const name = `${c.id} (${c.section})`;
    // The old pipeline is micromark, so it is a reference only where micromark is right in the default dialect.
    const want = expected(c);
    const micromark = output(c, 'micromark');
    if (!want || !micromark || canonicalHtml(micromark, { alerts: true }) !== canonicalHtml(want.html, { alerts: true })) {
      it.todo(`${name}: micromark differs from the references`);
      continue;
    }
    const reason = known.memos[c.id];
    (reason ? it.fails : it)(reason ? `${name}: ${reason}` : name, () => {
      const actual = canonicalHtml(renderEditor(c.markdown, { markdown: MEMO }), { alerts: true });
      const html = canonicalHtml(c.memos!, { alerts: true });
      if (actual !== html) failures.push({ layer: 'memos', id: c.id, from: 'the old memos pipeline', markdown: c.markdown, expected: html, actual });
      expect(actual, 'expected from the old memos pipeline').toBe(html);
    });
  }
});

const GFM = {
  allowDangerousHtml: true,
  allowDangerousProtocol: true,
  extensions: [gfmAutolinkLiteral(), gfmStrikethrough(), gfmTable(), gfmTaskListItem()],
  htmlExtensions: [gfmAutolinkLiteralHtml(), gfmStrikethroughHtml(), gfmTableHtml(), gfmTaskListItemHtml()],
};

describe('elsewhere', () => {
  for (const c of corpus.cases) {
    // micromark has no line break mode.
    if (c.breaks) continue;
    const name = `${c.id} (${c.section})`;
    const want = expected(c);
    const original = output(c, 'micromark');
    if (!want || !original || canonicalHtml(original) !== canonicalHtml(want.html)) continue;
    const reason = known.elsewhere[c.id];
    (reason ? it.fails : it)(reason ? `${name}: ${reason}` : name, () => {
      const saved = serializeMarkdown(parseMarkdown(c.markdown));
      const actual = canonicalHtml(micromark(saved, GFM));
      const html = canonicalHtml(original);
      if (actual !== html) failures.push({ layer: 'elsewhere', id: c.id, from: 'micromark, for the original', markdown: c.markdown, expected: html, actual: `${actual}\n--- saved Markdown ---\n${saved}` });
      expect(actual, `saved as:\n${saved}`).toBe(html);
    });
  }
});

describe('saved', () => {
  for (const c of corpus.cases) {
    const reason = known.saved[c.id];
    (reason ? it.fails : it)(reason ? `${c.id} (${c.section}): ${reason}` : `${c.id} (${c.section})`, () => {
      const options: MarkdownOptions = c.breaks ? { breaks: true } : {};
      const saved = serializeMarkdown(parseMarkdown(c.markdown, options), options);
      const before = canonicalHtml(renderEditor(c.markdown, { markdown: options }), { alerts: true });
      const after = canonicalHtml(renderEditor(saved, { markdown: options }), { alerts: true });
      if (after !== before) failures.push({ layer: 'saved', id: c.id, from: 'the original Markdown', markdown: c.markdown, expected: before, actual: `${after}\n--- saved Markdown ---\n${saved}` });
      expect(after, `saved as:\n${saved}`).toBe(before);
    });
  }
});
