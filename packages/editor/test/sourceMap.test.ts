// Source ranges: where the inline parser says each node and its markup is
// written, and the source maps loading builds from them (src/markdown/sourceMap.ts).

import { describe, expect, it } from 'vitest';
import { type InlineNode, type Range } from '../src/markdown/ast';
import { parseInlines } from '../src/markdown/inline';
import { loadMarkdown } from '../src/markdown/source';
import { fromSource, toSource } from '../src/markdown/sourceMap';
import { containerContent, inlineText } from '../src/model';
import * as src from '../src/sourceMode';
import { commonmark, gfm } from './fixtures/examples';

const parse = (md: string) => parseInlines(md, new Map(), [], true);

/** `[kind, written text]` of each piece of a node's markup. */
const syntaxOf = (md: string, node: InlineNode) => (node.type === 'text' ? [] : (node.syntax ?? [])).map((s) => [s.kind, md.slice(s.from, s.to)]);

describe('inline source ranges', () => {
  it('records where each node is written', () => {
    const md = 'a **b** [c](/d "e") `f` <g@h.i> \\* &amp; ![j](k) www.x.y';
    const nodes = parse(md);
    expect(nodes.map((n) => md.slice(n.pos!.from, n.pos!.to))).toEqual([
      'a ',
      '**b**',
      ' ',
      '[c](/d "e")',
      ' ',
      '`f`',
      ' ',
      '<g@h.i>',
      ' \\* &amp; ',
      '![j](k)',
      ' ',
      'www.x.y',
    ]);
    expect(nodes.map((n) => n.type)).toEqual(['text', 'strong', 'text', 'link', 'text', 'code', 'text', 'link', 'text', 'image', 'text', 'link']);
  });

  it('records the markup of emphasis, links, code spans, autolinks, escapes and images', () => {
    const md = 'a **b** [c](/d "e") `f` <g@h.i> \\* &amp; ![j](k) www.x.y';
    const [, strong, , link, , code, , autolink, escaped, image, , www] = parse(md);
    expect(syntaxOf(md, strong!)).toEqual([
      ['open', '**'],
      ['close', '**'],
    ]);
    expect(syntaxOf(md, link!)).toEqual([
      ['open', '['],
      ['close', ']'],
      ['tail', '(/d "e")'],
      ['dest', '/d'],
      ['title', '"e"'],
    ]);
    expect(syntaxOf(md, code!)).toEqual([
      ['open', '`'],
      ['close', '`'],
    ]);
    expect(code?.type === 'code' ? md.slice(code.content!.from, code.content!.to) : null).toBe('f');
    expect(syntaxOf(md, autolink!)).toEqual([
      ['open', '<'],
      ['dest', 'g@h.i'],
      ['close', '>'],
    ]);
    // An escape's backslash is in the gap before its piece, not markup of its own.
    expect(escaped?.type === 'text' ? escaped.value : null).toBe(' * & ');
    expect(syntaxOf(md, image!)).toEqual([
      ['open', '!['],
      ['close', ']'],
      ['tail', '(k)'],
      ['dest', 'k'],
    ]);
    expect(syntaxOf(md, www!)).toEqual([['dest', 'www.x.y']]);
  });

  it('keeps the verbatim pieces of text with escapes and entities', () => {
    const md = 'x \\* &amp; y';
    const text = parse(md)[0]!;
    if (text.type !== 'text') throw new Error('expected text');
    expect(text.value).toBe('x * & y');
    expect(text.pieces!.map((p) => [md.slice(p.from, p.to), text.value.slice(p.at, p.at + p.to - p.from)])).toEqual([
      ['x ', 'x '],
      [' ', ' '],
      [' y', ' y'],
    ]);
    // Plain text has no pieces: it is one verbatim slice.
    expect(parse('plain')[0]).toEqual({ type: 'text', value: 'plain', pos: { from: 0, to: 5 } });
  });

  it('gives a line break the line ending and the next line’s indentation, and trimmed spaces', () => {
    const md = 'a  \n  b\nc\\\nd';
    const [a, hard, b, soft, c, backslash, d] = parse(md);
    expect(md.slice(a!.pos!.from, a!.pos!.to)).toBe('a');
    expect([hard!.type, md.slice(hard!.pos!.from, hard!.pos!.to)]).toEqual(['hardBreak', '  \n  ']);
    expect(md.slice(b!.pos!.from, b!.pos!.to)).toBe('b');
    expect([soft!.type, md.slice(soft!.pos!.from, soft!.pos!.to)]).toEqual(['softBreak', '\n']);
    expect(md.slice(c!.pos!.from, c!.pos!.to)).toBe('c');
    expect([backslash!.type, md.slice(backslash!.pos!.from, backslash!.pos!.to)]).toEqual(['hardBreak', '\\\n']);
    expect(md.slice(d!.pos!.from, d!.pos!.to)).toBe('d');
  });

  it('uses the innermost delimiters of a run', () => {
    const before = parse('***a**');
    expect(before.map((n) => ['***a**'.slice(n.pos!.from, n.pos!.to), n.type])).toEqual([
      ['*', 'text'],
      ['**a**', 'strong'],
    ]);
    const after = parse('**a***');
    expect(after.map((n) => ['**a***'.slice(n.pos!.from, n.pos!.to), n.type])).toEqual([
      ['**a**', 'strong'],
      ['*', 'text'],
    ]);
    // The code span's text is between the runs, less a stripped space on each side.
    const [code] = parse('`` ` ``');
    expect(code?.type === 'code' ? '`` ` ``'.slice(code.content!.from, code.content!.to) : null).toBe('`');
  });

  it('splits e-mail literals with their ranges', () => {
    const md = 'mail a@b.co now';
    const nodes = parse(md);
    expect(nodes.map((n) => [n.type, md.slice(n.pos!.from, n.pos!.to)])).toEqual([
      ['text', 'mail '],
      ['link', 'a@b.co'],
      ['text', ' now'],
    ]);
  });
});

/** The text of a block, as the editor sees it. */
function textOf(block: Parameters<typeof containerContent>[0]): string | null {
  const content = containerContent(block);
  return content ? inlineText(content) : null;
}

describe('source maps', () => {
  const examples = [...commonmark, ...gfm].map((e) => e.markdown);

  it('map text written as such offset for offset, in order, for every spec example', () => {
    for (const markdown of examples) {
      const loaded = loadMarkdown(markdown);
      for (const block of loaded.doc.blocks) {
        const segments = loaded.source.mapOf.get(block);
        if (!segments) continue;
        const text = textOf(block);
        expect(text, JSON.stringify(markdown)).not.toBeNull();
        let lastTo = 0;
        let lastSrcTo = 0;
        for (const s of segments) {
          const where = `${JSON.stringify(markdown)} ${JSON.stringify(s)}`;
          expect(s.from >= lastTo && s.to >= s.from && s.to <= text!.length, where).toBe(true);
          expect(s.srcFrom >= lastSrcTo && s.srcTo >= s.srcFrom && s.srcTo <= markdown.length, where).toBe(true);
          if (s.linear) {
            expect(s.srcTo - s.srcFrom, where).toBe(s.to - s.from);
            // NUL characters are read as U+FFFD, so their text differs.
            if (!markdown.includes('\0')) expect(markdown.slice(s.srcFrom, s.srcTo), where).toBe(text!.slice(s.from, s.to));
          }
          lastTo = s.to;
          lastSrcTo = s.srcTo;
        }
      }
    }
  });

  it('map every offset there and back, for every spec example', () => {
    for (const markdown of examples) {
      const loaded = loadMarkdown(markdown);
      for (const block of loaded.doc.blocks) {
        const segments = loaded.source.mapOf.get(block);
        if (!segments || segments.length === 0) continue;
        const text = textOf(block)!;
        for (let m = 0; m <= text.length; m++) {
          const s = toSource(segments, m);
          expect(s >= 0 && s <= markdown.length, `${JSON.stringify(markdown)} offset ${m}`).toBe(true);
          const back = fromSource(segments, s);
          const inside = segments.find((seg) => seg.linear && seg.from < m && m < seg.to);
          if (inside) expect(back, `${JSON.stringify(markdown)} offset ${m}`).toBe(m);
          else expect(back >= 0 && back <= text.length, `${JSON.stringify(markdown)} offset ${m}`).toBe(true);
        }
      }
    }
  });

  it('take the caret of every block to its text and back to the same block, for every spec example', () => {
    for (const markdown of examples) {
      const loaded = loadMarkdown(markdown);
      loaded.doc.blocks.forEach((block, index) => {
        const text = textOf(block);
        for (const offset of [0, text?.length ?? 0]) {
          const pos = { blockId: block.id, offset };
          const at = src.toSourceOffset(loaded.doc, pos, loaded);
          const where = `${JSON.stringify(markdown)} block ${index} offset ${offset}`;
          expect(at >= 0 && at <= markdown.length, where).toBe(true);
          if (loaded.source.mapOf.get(block)) expect(src.fromSourceOffset(at, loaded).blockId, where).toBe(block.id);
        }
      });
    }
  });

  it('cover a byte order mark, CRLF line endings, tabs and quoted code', () => {
    const md = '﻿# A\r\n\r\n>\tx `y\r\n> z`\r\n\r\n-\tcode\r\n';
    const loaded = loadMarkdown(md);
    const [heading, quote, item] = loaded.doc.blocks;
    const at = (block: typeof heading, offset: number) => src.toSourceOffset(loaded.doc, { blockId: block!.id, offset }, loaded);
    expect(at(heading, 1)).toBe(md.indexOf('A') + 1);
    // "x y z": the code span's line ending became a space.
    expect(textOf(quote!)).toBe('x y z');
    expect(at(quote, 0)).toBe(md.indexOf('x'));
    expect(at(quote, 2)).toBe(md.indexOf('y'));
    expect(at(quote, 4)).toBe(md.indexOf('z'));
    expect(at(item, 2)).toBe(md.indexOf('code') + 2);
    expect(src.fromSourceOffset(md.indexOf('z'), loaded)).toEqual({ blockId: quote!.id, offset: 4 });
  });
});
