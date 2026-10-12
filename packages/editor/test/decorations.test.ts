import { describe, expect, it } from 'vitest';
import { decorationContext, splitByDecorations } from '../src/decorations';
import { textDecorator } from '../src/extensions/textDecorator';
import { paragraph } from '../src/model';
import { parseMarkdown } from '../src/markdown/parse';

const contextOf = (md: string) => {
  const block = parseMarkdown(md).blocks[0]!;
  return decorationContext(block, 'content' in block ? block.content : []);
};

describe('textDecorator', () => {
  const tags = textDecorator({ pattern: /#[\w/]+/, class: 'tag' });

  it('decorates matches and skips code, links and images', () => {
    const ctx = contextOf('#a and `#b` and [#c](x) and #d/e');
    expect(ctx.text).toBe('#a and #b and #c and #d/e');
    expect(tags.decorations!(ctx).map((d) => ctx.text.slice(d.from, d.to))).toEqual(['#a', '#d/e']);
  });

  it('takes ranges and classes from a scanner', () => {
    const mentions = textDecorator({
      class: 'mention',
      scan: (text) => [...text.matchAll(/@\w+/g)].map((m) => ({ from: m.index!, to: m.index! + m[0].length, class: m[0] === '@me' ? 'self' : undefined })),
    });
    const ctx = contextOf('hi @me and @bob');
    expect(mentions.decorations!(ctx)).toEqual([
      { from: 3, to: 6, class: 'self' },
      { from: 11, to: 15, class: 'mention' },
    ]);
  });
});

describe('splitByDecorations', () => {
  it('splits spans at decoration edges and keeps marks', () => {
    const block = parseMarkdown('ab **cd** ef').blocks[0]!;
    const content = 'content' in block ? block.content : [];
    const pieces = splitByDecorations(content, [{ from: 1, to: 4, class: 'x' }]);
    expect(pieces.map((p) => [p.span.text, p.span.marks.join(','), p.decorations.length])).toEqual([
      ['a', '', 0],
      ['b ', '', 1],
      ['c', 'bold', 1],
      ['d', 'bold', 0],
      [' ef', '', 0],
    ]);
  });

  it('never splits an atomic span; a decoration covers it only if it covers all of it', () => {
    const content = [
      { text: 'a ', marks: [] },
      { text: '$x+y$', marks: [], token: 'math' },
      { text: ' b', marks: [] },
    ];
    const pieces = splitByDecorations(content, [{ from: 1, to: 4, class: 'x' }, { from: 0, to: 9, class: 'all' }], (span, from) => {
      expect(from).toBe(span.token ? 2 : from);
      return !!span.token;
    });
    expect(pieces.map((p) => [p.span.text, p.atomic, p.decorations.map((d) => d.class).join(',')])).toEqual([
      ['a', false, 'all'],
      [' ', false, 'x,all'],
      ['$x+y$', true, 'all'],
      [' b', false, 'all'],
    ]);
  });

  it('returns spans unchanged without decorations', () => {
    const content = paragraph([{ text: 'x', marks: [] }]).content;
    expect(splitByDecorations(content, [])[0]!.span).toBe(content[0]);
  });
});
