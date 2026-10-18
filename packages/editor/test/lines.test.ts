// Lines of inline content: `inlineLines` splits spans at line breaks, so an
// app can look at what the user wrote on one line (a bare link on its own
// line, with the `breaks` option).

import { describe, expect, it } from 'vitest';
import { type Inline, inlineLines, inlineText } from '../src/model';
import { parseMarkdown } from '../src/index';

const content = (markdown: string, breaks = true): Inline => {
  const block = parseMarkdown(markdown, { breaks }).blocks[0]!;
  return 'content' in block ? block.content : [];
};

describe('inlineLines', () => {
  it('keeps content with no break as one line, and empty content as one empty line', () => {
    const one = content('one *two*');
    expect(inlineLines(one)).toEqual([one]);
    expect(inlineLines([])).toEqual([[]]);
  });

  it('splits at line breaks, keeping each span’s format and dropping the breaks', () => {
    const lines = inlineLines(content('test\nhttps://example.com\n**bold** end'));
    expect(lines.map(inlineText)).toEqual(['test', 'https://example.com', 'bold end']);
    expect(lines[1]).toEqual([{ text: 'https://example.com', marks: [], link: 'https://example.com' }]);
    expect(lines[2]![0]).toEqual({ text: 'bold', marks: ['bold'] });
  });

  it('gives an empty line for a break at the start, the end, or next to another', () => {
    expect(inlineLines([{ text: '\na\n\nb\n', marks: [] }]).map(inlineText)).toEqual(['', 'a', '', 'b', '']);
  });

  it('splits one span that holds several lines', () => {
    const lines = inlineLines([{ text: 'a\nb', marks: ['italic'] }]);
    expect(lines).toEqual([[{ text: 'a', marks: ['italic'] }], [{ text: 'b', marks: ['italic'] }]]);
  });

  it('reads a hard break as a line in the default dialect, and a soft break as the same line', () => {
    expect(inlineLines(content('a\\\nb', false)).map(inlineText)).toEqual(['a', 'b']);
    expect(inlineLines(content('a\nb', false)).map(inlineText)).toEqual(['a b']);
  });
});
