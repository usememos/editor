// Builds test/conformance/corpus.json: every case from the vendored test
// suites in test/conformance/vendor, with the HTML that popular renderers
// give for it. The conformance tests compare the editor with these outputs,
// never with the editor's own.
//
//   npm run conformance:corpus
//
// Renderers: cmark-gfm (GitHub's parser, through scripts/cmark-gfm.py, which
// needs `python3 -m pip install cmarkgfm==2025.10.22`), micromark with the GFM
// extensions (whose own fixtures are crawled from github.com), commonmark.js
// and markdown-it. Cases from micromark's fixture pairs also carry the HTML
// that github.com rendered.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compile, micromark, parse, postprocess, preprocess } from 'micromark';
import { gfmAutolinkLiteral, gfmAutolinkLiteralHtml } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough, gfmStrikethroughHtml } from 'micromark-extension-gfm-strikethrough';
import { gfmTable, gfmTableHtml } from 'micromark-extension-gfm-table';
import { gfmTaskListItem, gfmTaskListItemHtml } from 'micromark-extension-gfm-task-list-item';

const require = createRequire(import.meta.url);
const commonmark = require('commonmark');
const MarkdownIt = require('markdown-it');

const testDir = fileURLToPath(new URL('../test/', import.meta.url));
const vendor = testDir + 'conformance/vendor/';

/** Examples in the spec.txt format of CommonMark and cmark-gfm, with `→` for tabs. */
function specExamples(file) {
  const out = [];
  let section = '';
  let example = null;
  let part = 0;
  for (const line of readFileSync(vendor + file, 'utf8').split('\n')) {
    if (example) {
      if (line.startsWith('````````````````````````````````')) {
        out.push({ section, extension: example.extension, markdown: example.md.join(''), spec: example.html.join('') });
        example = null;
      } else if (line === '.' && part === 0) part = 1;
      else (part === 0 ? example.md : example.html).push(line.replaceAll('→', '\t') + '\n');
      continue;
    }
    const m = /^```````````````````````````````` example ?(.*)$/.exec(line);
    if (m) {
      example = { extension: m[1] || undefined, md: [], html: [] };
      part = 0;
    } else if (/^#{1,6} /.test(line)) section = line.replace(/^#+ /, '').trim();
  }
  return out;
}

/** markdown-it's fixture format: a title, then `.`-separated Markdown and the HTML markdown-it expects. */
function markdownItFixtures(file) {
  const lines = readFileSync(vendor + file, 'utf8').split('\n');
  const out = [];
  let title = '';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '.') {
      if (lines[i].trim()) title = lines[i].trim();
      continue;
    }
    const md = [];
    for (i++; i < lines.length && lines[i] !== '.'; i++) md.push(lines[i] + '\n');
    const html = [];
    for (i++; i < lines.length && lines[i] !== '.'; i++) html.push(lines[i] + '\n');
    out.push({ section: title, markdown: md.join(''), spec: html.join('') });
  }
  return out;
}

/**
 * micromark's fixture pairs: Markdown and the HTML github.com rendered for it.
 * `.comment` files were rendered as a comment, where a newline is a line
 * break. As in micromark's own tests (`controlPictures`), a control picture
 * in the Markdown stands for its control character: `␠` for a space that an
 * editor would strip, `␉` for a tab. GitHub's `class="notranslate"` on code is
 * dropped: it changes nothing a reader sees.
 */
function githubPairs(dir) {
  return readdirSync(vendor + dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({
      section: f.replace(/\.md$/, ''),
      markdown: readFileSync(vendor + dir + '/' + f, 'utf8').replace(/[\u2400-\u2421]/g, (c) => String.fromCharCode(c === '\u2421' ? 0x7f : c.charCodeAt(0) - 0x2400)),
      github: readFileSync(vendor + dir + '/' + f.replace(/\.md$/, '.html'), 'utf8').replaceAll(' class="notranslate"', ''),
      breaks: f.includes('.comment.') || undefined,
    }));
}

const suites = [
  ['commonmark', () => JSON.parse(readFileSync(testDir + 'fixtures/commonmark-0.31.2.json', 'utf8')).map((e) => ({ section: e.section, markdown: e.markdown, spec: e.html }))],
  ['cmark-gfm-spec', () => specExamples('cmark-gfm/spec.txt')],
  ['cmark-gfm-extensions', () => specExamples('cmark-gfm/extensions.txt')],
  ['cmark-gfm-regression', () => specExamples('cmark-gfm/regression.txt')],
  ['cmark-regression', () => specExamples('cmark/regression.txt')],
  ['commonmark.js-regression', () => specExamples('commonmark.js/regression.txt')],
  ['markdown-it-tables', () => markdownItFixtures('markdown-it/tables.txt')],
  ['markdown-it-strikethrough', () => markdownItFixtures('markdown-it/strikethrough.txt')],
  ['markdown-it-commonmark-extras', () => markdownItFixtures('markdown-it/commonmark_extras.txt')],
  ['markdown-it-normalize', () => markdownItFixtures('markdown-it/normalize.txt')],
  ['github-autolink-literal', () => githubPairs('micromark-gfm/autolink-literal')],
  ['github-table', () => githubPairs('micromark-gfm/table')],
  ['github-strikethrough', () => githubPairs('micromark-gfm/strikethrough')],
  ['github-task-list-item', () => githubPairs('micromark-gfm/task-list-item')],
  ['realistic', () => JSON.parse(readFileSync(testDir + 'conformance/realistic.json', 'utf8')).map((c) => ({ section: c.section, markdown: c.markdown }))],
];

const cases = [];
const seen = new Map();
for (const [source, load] of suites) {
  load().forEach((c, i) => {
    const key = `${c.breaks ? 'breaks:' : ''}${c.markdown}`;
    // A Markdown input already in the corpus is one case, listed under its first source.
    if (seen.has(key)) {
      seen.get(key).also.push(`${source}#${i + 1}`);
      return;
    }
    const entry = { id: `${source}#${i + 1}`, section: c.section, markdown: c.markdown, also: [] };
    if (c.extension) entry.extension = c.extension;
    if (c.breaks) entry.breaks = true;
    if (c.spec !== undefined) entry.spec = c.spec;
    if (c.github !== undefined) entry.github = c.github;
    seen.set(key, entry);
    cases.push(entry);
  });
}

const gfmOptions = {
  allowDangerousHtml: true,
  allowDangerousProtocol: true,
  extensions: [gfmAutolinkLiteral(), gfmStrikethrough(), gfmTable(), gfmTaskListItem()],
  htmlExtensions: [gfmAutolinkLiteralHtml(), gfmStrikethroughHtml(), gfmTableHtml(), gfmTaskListItemHtml()],
};
/** Tokens whose line endings are not text: remark-breaks leaves them alone. */
const NOT_TEXT = new Set(['codeText', 'htmlText', 'resource', 'reference', 'image']);

/**
 * The memos dialect as the old memos pipeline rendered it (memos 5cfe9c0^:
 * remark-gfm, remark-disable-setext and remark-breaks), through micromark:
 * setext underlines are disabled, and a soft line ending in paragraph text
 * is a line break.
 */
function memosHtml(markdown) {
  const options = { ...gfmOptions, extensions: [...gfmOptions.extensions, { disable: { null: ['setextUnderline'] } }] };
  const events = postprocess(parse(options).document().write(preprocess()(markdown, undefined, true)));
  let paragraphs = 0;
  let notText = 0;
  events.forEach(([kind, token], i) => {
    const step = kind === 'enter' ? 1 : -1;
    if (token.type === 'paragraph') paragraphs += step;
    else if (NOT_TEXT.has(token.type)) notText += step;
    else if (token.type === 'lineEnding' && kind === 'enter' && paragraphs > 0 && notText === 0) {
      const [, before] = events[i - 1] ?? [];
      if (before?.type !== 'hardBreakEscape' && before?.type !== 'hardBreakTrailing') token.type = 'hardBreakTrailing';
    }
  });
  return compile(options)(events);
}

const cmReader = new commonmark.Parser();
const cmWriter = new commonmark.HtmlRenderer();
const mdit = new MarkdownIt('commonmark', { html: true });
const cmarkGfm = JSON.parse(
  execFileSync('python3', [fileURLToPath(new URL('./cmark-gfm.py', import.meta.url))], {
    input: JSON.stringify(cases.map((c) => ({ markdown: c.markdown, breaks: !!c.breaks }))),
    maxBuffer: 1 << 28,
  }).toString(),
);
cases.forEach((c, i) => {
  c.cmarkGfm = cmarkGfm[i];
  if (c.breaks) return;
  c.micromark = micromark(c.markdown, gfmOptions);
  // Only where the dialect changes the result.
  const memos = memosHtml(c.markdown);
  if (memos !== c.micromark) c.memos = memos;
  c.commonmark = cmWriter.render(cmReader.parse(c.markdown));
  c.markdownIt = mdit.render(c.markdown);
  for (const key of ['cmarkGfm', 'micromark', 'commonmark', 'markdownIt']) if (c[key] === c.cmarkGfm && key !== 'cmarkGfm') c[key] = '=cmarkGfm';
});

const header = {
  about: 'Generated by packages/editor/scripts/conformance.mjs from test/conformance/vendor. Do not edit.',
  renderers: {
    cmarkGfm: 'cmark-gfm through cmarkgfm 2025.10.22 (tables, autolinks, strikethrough, task lists, unsafe HTML)',
    micromark: 'micromark 4.0.2 with the GFM autolink literal 2.1.0, strikethrough 2.1.0, table 2.1.2 and task list item 2.1.0 extensions (no footnotes, no tagfilter)',
    commonmark: 'commonmark.js 0.31.2',
    markdownIt: 'markdown-it 15.0.2, commonmark preset, html on',
    memos: 'the memos dialect (breaks, no setext headings) as the old memos pipeline rendered it: micromark as above, setext underlines disabled, and soft line endings in paragraph text as line breaks (remark-breaks). Only where it differs from micromark',
  },
};
writeFileSync(testDir + 'conformance/corpus.json', JSON.stringify({ ...header, cases }, null, 1) + '\n');
console.log(`${cases.length} cases`);
