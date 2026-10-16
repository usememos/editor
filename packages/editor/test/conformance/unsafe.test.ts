// @vitest-environment happy-dom
//
// mdast-util-to-markdown's unsafe patterns (lib/unsafe.js): each says where a
// character in text would be read as syntax. For every phrasing and line
// start pattern, plain text holding the character in that position is put in
// a paragraph, a heading, a list item, a quote and a table cell, and saved.
// The saved Markdown must load back as the same text, and micromark with the
// GFM extensions must show it as that text.
//
// Spaces and tabs next to a line break are left out: the serializer drops
// them on purpose, as CommonMark strips them. So is `\r`, which the model
// does not hold, and a line break at the end, which Markdown cannot write
// (the editor saves it as `&#10;` to keep it, and other renderers show none).

import { micromark } from 'micromark';
import { gfmAutolinkLiteral, gfmAutolinkLiteralHtml } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough, gfmStrikethroughHtml } from 'micromark-extension-gfm-strikethrough';
import { gfmTable, gfmTableHtml } from 'micromark-extension-gfm-table';
import { gfmTaskListItem, gfmTaskListItemHtml } from 'micromark-extension-gfm-task-list-item';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/markdown/parse';
import { serializeMarkdown } from '../../src/markdown/serialize';
import { type Block, heading, inlineText, listItem, paragraph, plain, quote, table } from '../../src/model';
import { canonicalHtml } from './canonical';

interface Pattern {
  readonly character: string;
  readonly before?: string;
  readonly after?: string;
  readonly atBreak?: boolean;
}

/** The phrasing and line start patterns of mdast-util-to-markdown 2.1.2, lib/unsafe.js. */
const UNSAFE: readonly Pattern[] = [
  { character: '\n', before: '\\n' },
  { character: '\n', after: '[\\r\\n]' },
  { character: '!', after: '\\[' },
  { atBreak: true, character: '#' },
  { character: '&', after: '[#A-Za-z]' },
  { before: '\\]', character: '(' },
  { atBreak: true, before: '\\d+', character: ')' },
  { atBreak: true, character: '*', after: '(?:[ \t\r\n*])' },
  { character: '*' },
  { atBreak: true, character: '+', after: '(?:[ \t\r\n])' },
  { atBreak: true, character: '-', after: '(?:[ \t\r\n-])' },
  { atBreak: true, before: '\\d+', character: '.', after: '(?:[ \t\r\n]|$)' },
  { atBreak: true, character: '<', after: '[!/?A-Za-z]' },
  { character: '<', after: '[!/?A-Za-z]' },
  { atBreak: true, character: '=' },
  { atBreak: true, character: '>' },
  { atBreak: true, character: '[' },
  { character: '[' },
  { character: '\\', after: '[\\r\\n]' },
  { atBreak: true, character: '_' },
  { character: '_' },
  { atBreak: true, character: '`' },
  { character: '`' },
  { atBreak: true, character: '~' },
];

/** Text matching each `before` or `after` pattern. Unset: nothing, a letter, or a space. */
const SAMPLES: Record<string, readonly string[]> = {
  '\\n': ['\n'],
  '[\\r\\n]': ['\n'],
  '\\[': ['[', '[a](b)', '[a]'],
  '[#A-Za-z]': ['amp;', '#35;', 'a'],
  '\\]': [']', '[a]'],
  '\\d+': ['1', '12'],
  '(?:[ \t\r\n*])': [' ', '*', '\n', '* a*'],
  '(?:[ \t\r\n])': [' ', '\n'],
  '(?:[ \t\r\n-])': [' ', '-', '--', '\n'],
  '(?:[ \t\r\n]|$)': [' ', '', '\n'],
  '[!/?A-Za-z]': ['a>', 'a', '!--', '/a>', '?x?>', '!A>'],
};
const sides = (pattern: string | undefined, unset: readonly string[]) => (pattern === undefined ? unset : SAMPLES[pattern]!);

/** Texts that put the pattern's character in its unsafe position. */
function texts(p: Pattern): string[] {
  const out = new Set<string>();
  for (const before of sides(p.before, p.atBreak ? [''] : ['', 'a', ' '])) {
    for (const after of sides(p.after, ['', 'a', ' '])) {
      const run = before + p.character + after;
      if (p.atBreak) {
        out.add(`${run} x`);
        out.add(`x\n${run} y`);
      } else {
        out.add(run);
        out.add(`x ${run} y`);
        out.add(`x${run}y`);
      }
    }
  }
  // Only what Markdown can write: no space or tab next to a line break or at an end, no line break at the end.
  return [...out].filter((t) => !/[ \t]\n|\n[ \t]|^[ \t]|[ \t]$|\n$/.test(t));
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const lines = (s: string) => escapeHtml(s).replace(/\n/g, '<br>\n');

interface Context {
  readonly name: string;
  /** False where a line break is not text: headings and table cells save one as `&#10;`. */
  readonly multiline: boolean;
  block(text: string): Block;
  html(text: string): string;
  text(block: Block): string | null;
}

const content = (block: Block) => ('content' in block && block.content.every((s) => s.marks.length === 0 && !s.link && !s.image && !s.token) ? inlineText(block.content) : null);

const CONTEXTS: readonly Context[] = [
  { name: 'paragraph', multiline: true, block: (t) => paragraph(plain(t)), html: (t) => `<p>${lines(t)}</p>`, text: (b) => (b.type === 'paragraph' ? content(b) : null) },
  { name: 'heading', multiline: false, block: (t) => heading(2, plain(t)), html: (t) => `<h2>${escapeHtml(t)}</h2>`, text: (b) => (b.type === 'heading' ? content(b) : null) },
  {
    name: 'list item',
    multiline: true,
    block: (t) => listItem('bullet', plain(t)),
    html: (t) => `<ul><li>${lines(t)}</li></ul>`,
    text: (b) => (b.type === 'listItem' && b.listType === 'bullet' ? content(b) : null),
  },
  { name: 'quote', multiline: true, block: (t) => quote(plain(t)), html: (t) => `<blockquote><p>${lines(t)}</p></blockquote>`, text: (b) => (b.type === 'quote' ? content(b) : null) },
  {
    name: 'table cell',
    multiline: false,
    block: (t) => table([null], [[plain(t)]]),
    html: (t) => `<table><thead><tr><th>${escapeHtml(t)}</th></tr></thead></table>`,
    text: (b) => {
      const cell = b.type === 'table' && b.rows.length === 1 ? b.rows[0]![0] : undefined;
      return cell && cell.every((s) => s.marks.length === 0 && !s.link && !s.image) ? inlineText(cell) : null;
    },
  },
];

const GFM = {
  allowDangerousHtml: true,
  extensions: [gfmAutolinkLiteral(), gfmStrikethrough(), gfmTable(), gfmTaskListItem()],
  htmlExtensions: [gfmAutolinkLiteralHtml(), gfmStrikethroughHtml(), gfmTableHtml(), gfmTaskListItemHtml()],
};

describe('unsafe characters in text', () => {
  for (const pattern of UNSAFE) {
    const label = `${JSON.stringify(pattern.character)}${pattern.atBreak ? ' at a line start' : ''}${pattern.before ? ` after /${pattern.before}/` : ''}${pattern.after ? ` before /${pattern.after}/` : ''}`;
    for (const context of CONTEXTS) {
      const cases = texts(pattern).filter((t) => context.multiline || !t.includes('\n'));
      if (cases.length === 0) continue;
      it(`${label} in a ${context.name}`, () => {
        const wrong: string[] = [];
        for (const text of cases) {
          const saved = serializeMarkdown({ blocks: [context.block(text)] });
          const loaded = parseMarkdown(saved).blocks;
          const back = loaded.length === 1 ? context.text(loaded[0]!) : null;
          if (back !== text) wrong.push(`${JSON.stringify(text)} saved as ${JSON.stringify(saved)} loads as ${JSON.stringify(back)}`);
          const shown = canonicalHtml(micromark(saved, GFM));
          if (shown !== canonicalHtml(context.html(text))) wrong.push(`${JSON.stringify(text)} saved as ${JSON.stringify(saved)} shows in micromark as ${JSON.stringify(shown)}`);
        }
        expect(wrong).toEqual([]);
      });
    }
  }
});
