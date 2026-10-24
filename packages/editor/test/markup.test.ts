// Markup ranges (src/markdown/markup.ts) and source mode's highlighting over them (src/sourceHighlight.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decorationContext } from '../src/decorations';
import { tags } from '../src/extensions/tags';
import { markdownMarkup } from '../src/markdown/markup';
import { SYNC_LIMIT, SourceHighlighter, highlightDecorations, sourceDecorations, sourceInline } from '../src/sourceHighlight';
import { codeBlock, inlineText } from '../src/model';

/** `[kind, text]` of each range. */
const show = (md: string) => markdownMarkup(md).ranges.map((r) => [r.kind, md.slice(r.from, r.to)]);

describe('markdownMarkup', () => {
  it('marks inline syntax and the text it marks', () => {
    expect(show('a **b** *c* ~~d~~ `e` [f](/g "h") <i@j.k> www.l.m \\* &amp; ![n](o)\n')).toEqual([
      ['marker', '**'],
      ['strong', 'b'],
      ['marker', '**'],
      ['marker', '*'],
      ['em', 'c'],
      ['marker', '*'],
      ['marker', '~~'],
      ['strike', 'd'],
      ['marker', '~~'],
      ['marker', '`'],
      ['code', 'e'],
      ['marker', '`'],
      ['marker', '['],
      ['link', 'f'],
      ['marker', ']'],
      ['marker', '('],
      ['url', '/g'],
      ['marker', ' "h")'],
      ['marker', '<'],
      ['url', 'i@j.k'],
      ['marker', '>'],
      ['url', 'www.l.m'],
      ['escape', '\\*'],
      ['escape', '&amp;'],
      ['marker', '!['],
      ['link', 'n'],
      ['marker', ']'],
      ['marker', '('],
      ['url', 'o'],
      ['marker', ')'],
    ]);
  });

  it('marks headings, quotes, lists, tasks, breaks and tables', () => {
    const md = '## Title ##\n\nSetext\n===\n\n> quoted\n> - item\n>   wrapped\n\n- [x] done\n-\n  late\n1) one\n\n***\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
    expect(show(md)).toEqual([
      ['marker', '##'],
      ['heading', 'Title'],
      ['marker', '##'],
      ['heading', 'Setext'],
      ['marker', '==='],
      ['marker', '>'],
      ['marker', '>'],
      ['marker', '-'],
      ['marker', '>'],
      ['marker', '-'],
      ['marker', '[x]'],
      ['marker', '-'],
      ['marker', '1)'],
      ['marker', '***'],
      ['marker', '|'],
      ['marker', '|'],
      ['marker', '|'],
      ['marker', '| - | - |'],
      ['marker', '|'],
      ['marker', '|'],
      ['marker', '|'],
    ]);
  });

  it('marks fences, their info string and code, and leaves a literal star alone', () => {
    const md = 'a * b\n\n```js\nlet x = **y**;\n```\n\n    indented\n';
    expect(show(md)).toEqual([
      ['marker', '```'],
      ['lang', 'js'],
      ['code', 'let x = **y**;'],
      ['marker', '```'],
      ['code', 'indented'],
    ]);
    expect(markdownMarkup(md).code).toEqual([
      { from: md.indexOf('let'), to: md.indexOf(';') + 1, language: 'js' },
      { from: md.indexOf('indented'), to: md.indexOf('indented') + 8, language: '' },
    ]);
  });

  it('marks raw HTML, a hard break’s backslash and nested emphasis in a link', () => {
    expect(show('<b>x</b> y\\\nz [*q*](u)\n')).toEqual([
      ['html', '<b>'],
      ['html', '</b>'],
      ['marker', '\\'],
      ['marker', '['],
      ['link', '*q*'],
      ['marker', '*'],
      ['em', 'q'],
      ['marker', '*'],
      ['marker', ']'],
      ['marker', '('],
      ['url', 'u'],
      ['marker', ')'],
    ]);
  });

  it('splits a range at line endings and prefixes', () => {
    const md = '> **a\n> b**\n';
    expect(show(md)).toEqual([
      ['marker', '>'],
      ['marker', '**'],
      ['strong', 'a'],
      ['marker', '>'],
      ['strong', 'b'],
      ['marker', '**'],
    ]);
  });
});

describe('highlighting', () => {
  it('gives each kind its class, and the theme’s class for it', () => {
    const md = '# T\n';
    expect(highlightDecorations(markdownMarkup(md)).map((d) => d.class)).toEqual(['mbe-src-marker', 'mbe-src-heading']);
    expect(highlightDecorations(markdownMarkup(md), { heading: 'font-bold' }).map((d) => d.class)).toEqual(['mbe-src-marker', 'mbe-src-heading font-bold']);
  });

  it('splits the text at syntax into prose and excluded spans', () => {
    const md = 'see #a and `#b` or [#c](x) **#d**\n';
    const inline = sourceInline(md, markdownMarkup(md));
    expect(inlineText(inline)).toBe(md);
    expect(inline.map((s) => [s.text, s.marks.length > 0])).toEqual([
      ['see #a and ', false],
      ['`#b`', true],
      [' or ', false],
      ['[', true],
      ['#c', false],
      ['](x)', true],
      [' ', false],
      ['**', true],
      ['#d', false],
      ['**', true],
      ['\n', false],
    ]);
  });

  it('lets tags() decorate the same tags as in rich mode', () => {
    const md = 'see #a and `#b` or [#c](x) **#d** <https://x.y/#e>\n';
    const ctx = decorationContext(codeBlock('', md), sourceInline(md, markdownMarkup(md)));
    expect(tags().decorations!(ctx).map((d) => md.slice(d.from, d.to))).toEqual(['#a', '#c', '#d']);
  });
});

describe('sourceDecorations', () => {
  it('runs the code decorators on each fence, their offsets moved and clipped to the code', () => {
    const md = 'a\n\n```js\nlet x\n```\n';
    const block = codeBlock('', md);
    const decorations = sourceDecorations(block, md, markdownMarkup(md), {
      highlight: false,
      decorators: [],
      codeDecorators: [({ text, language }) => [{ from: 0, to: 3, class: language }, { from: 2, to: text.length + 5, class: 'past' }]],
    });
    expect(decorations.map((d) => [d.class, md.slice(d.from, d.to)])).toEqual([
      ['js', 'let'],
      ['past', 't x'],
    ]);
  });
});

describe('SourceHighlighter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('moves the decorations through a keystroke in a long text, and computes the exact ones once typing pauses', () => {
    const line = 'some **bold** text #tag\n';
    const text = line.repeat(Math.ceil(SYNC_LIMIT / line.length) + 1);
    let computed = 0;
    let ready = 0;
    const highlighter = new SourceHighlighter(
      undefined,
      // Fresh attribute objects every time, as a decorator with an onClick makes them.
      () => ({ highlight: true, decorators: [({ text }) => [{ from: text.indexOf('#tag'), to: text.indexOf('#tag') + 4, class: 'tag', attributes: { 'data-tag': 'tag' } }]], codeDecorators: [] }),
      () => ready++,
    );
    const first = highlighter.decorations(codeBlock('', text));
    computed++;
    const bold = first.filter((d) => d.class === 'mbe-src-strong');
    expect(bold.length).toBe(text.split('\n').length - 1);
    // A letter typed inside the first bold word: the decorations after it move by one, the word's grows.
    const edited = text.slice(0, 8) + 'x' + text.slice(8);
    const shifted = highlighter.decorations(codeBlock('', edited));
    expect(shifted.filter((d) => d.class === 'mbe-src-strong').map((d) => edited.slice(d.from, d.to)).slice(0, 2)).toEqual(['bxold', 'bold']);
    expect(shifted.find((d) => d.class === 'tag')!.from).toBe(edited.indexOf('#tag'));
    // The exact ones are the same, so nothing is rendered again.
    vi.runAllTimers();
    expect(ready).toBe(0);
    expect(highlighter.decorations(codeBlock('', edited))).toBe(highlighter.decorations(codeBlock('', edited)));
    // Closing a new pair changes the highlighting: the block is rendered again.
    const closed = edited.replace('text #tag', '**text** #tag');
    highlighter.decorations(codeBlock('', closed));
    vi.runAllTimers();
    expect(ready).toBe(1);
    expect(computed).toBe(1);
    highlighter.destroy();
  });
});
