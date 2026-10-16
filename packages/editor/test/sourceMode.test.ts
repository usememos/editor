// Source mode's plain text edits and the caret mapping between a rich document and
// its text (see src/sourceMode.ts).

import { describe, expect, it } from 'vitest';
import { loadMarkdown } from '../src/markdown/source';
import { nextGrapheme, previousGrapheme } from '../src/commands';
import { type EditorState } from '../src/model';
import * as src from '../src/sourceMode';

/** A source state from text with `|` for the caret, or `[` and `]` around the selection. */
function state(marked: string): EditorState {
  const caret = marked.indexOf('|');
  if (caret !== -1) return src.sourceState(marked.replace('|', ''), caret);
  const from = marked.indexOf('[');
  const to = marked.indexOf(']') - 1;
  return src.sourceState(marked.replace('[', '').replace(']', ''), from, to);
}

/** The text of a source state, marked as `state` reads it. */
function show(s: EditorState | null): string {
  const text = src.sourceText(s!.doc);
  const { from, to } = src.sourceRange(s!);
  if (from === to) return text.slice(0, from) + '|' + text.slice(from);
  return text.slice(0, from) + '[' + text.slice(from, to) + ']' + text.slice(to);
}

describe('text edits', () => {
  it('inserts and deletes text', () => {
    expect(show(src.insertSourceText(state('a[b]c'), 'xy'))).toBe('axy|c');
    expect(show(src.sourceDeleteBackward(state('ab|c'), previousGrapheme))).toBe('a|c');
    expect(show(src.sourceDeleteBackward(state('a👍|c'), previousGrapheme))).toBe('a|c');
    expect(src.sourceDeleteBackward(state('|abc'), previousGrapheme)).toBeNull();
    expect(show(src.sourceDeleteForward(state('a|bc'), nextGrapheme))).toBe('a|c');
    expect(src.sourceDeleteForward(state('abc|'), nextGrapheme)).toBeNull();
    expect(show(src.sourceDeleteForward(state('[ab]c'), nextGrapheme))).toBe('|c');
  });

  it('inserts at an offset, on lines of its own for a block', () => {
    expect(show(src.insertSourceAt(state('ab|'), 1, 'X', false, false))).toBe('aX|b');
    expect(show(src.insertSourceAt(state('one|\ntwo'), 4, '![](a.png)', true, false))).toBe('one\n![](a.png)|\ntwo');
    expect(show(src.insertSourceAt(state('one two|'), 3, '- x', true, false))).toBe('one\n- x|\n two');
    // Keeping the selection: text inserted before the caret moves it.
    expect(show(src.insertSourceAt(state('a\nb|'), 2, 'X', true, true))).toBe('a\nX\nb|');
    expect(show(src.insertSourceAt(state('a|\nb'), 3, 'X', true, true))).toBe('a|\nb\nX');
  });
});

describe('helpers', () => {
  it('maps an offset through one replaced range', () => {
    expect(src.mapOffset(0, 'abc', 'Xabc')).toBe(0);
    expect(src.mapOffset(2, 'abc', 'Xabc')).toBe(3);
    expect(src.mapOffset(3, 'abc', 'abXc')).toBe(4);
    expect(src.mapOffset(2, 'abcd', 'ad')).toBe(1);
    expect(src.mapOffset(0, 'abc', 'abc')).toBe(0);
  });
});

describe('caret mapping', () => {
  const at = (markdown: string, index: number, offset: number) => {
    const loaded = loadMarkdown(markdown);
    const pos = { blockId: loaded.doc.blocks[index]!.id, offset };
    return src.toSourceOffset(loaded.doc, pos, loaded);
  };
  const back = (markdown: string, offset: number) => {
    const loaded = loadMarkdown(markdown);
    const pos = src.fromSourceOffset(offset, loaded);
    return [loaded.doc.blocks.findIndex((b) => b.id === pos.blockId), pos.offset];
  };

  it('keeps the column where the text before the caret is verbatim', () => {
    const text = '# Title\n\nsome text\n\n- one\n- two\n\n> quoted\n';
    expect(at(text, 0, 3)).toBe(text.indexOf('Title') + 3);
    expect(at(text, 1, 4)).toBe(text.indexOf('some') + 4);
    expect(at(text, 2, 2)).toBe(text.indexOf('one') + 2);
    expect(at(text, 3, 3)).toBe(text.indexOf('two') + 3);
    expect(at(text, 4, 6)).toBe(text.indexOf('quoted') + 6);
    expect(back(text, text.indexOf('Title') + 3)).toEqual([0, 3]);
    expect(back(text, text.indexOf('two') + 1)).toEqual([3, 1]);
    expect(back(text, text.indexOf('quoted') + 6)).toEqual([4, 6]);
  });

  it('goes to the start of the block text when the text before the caret has syntax', () => {
    const text = 'a **b** c\n';
    // Rich offset 3 is after "a b": the source has "a **b".
    expect(at(text, 0, 3)).toBe(0);
    expect(at(text, 0, 2)).toBe(2);
  });

  it('maps an offset on a marker to the start of its block', () => {
    const text = 'x\n\n- item\n';
    expect(back(text, text.indexOf('- item'))).toEqual([1, 0]);
    expect(back(text, text.indexOf('item') + 2)).toEqual([1, 2]);
  });

  it('maps every offset of every block back to the same block', () => {
    const text = '# H\n\npara one\nline two\n\n- a\n  - b\n1. c\n\n```js\ncode\n```\n\n> q\n> r\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\nend\n';
    const loaded = loadMarkdown(text);
    loaded.doc.blocks.forEach((block, index) => {
      const pos = { blockId: block.id, offset: 0 };
      const offset = src.toSourceOffset(loaded.doc, pos, loaded);
      expect(src.fromSourceOffset(offset, loaded).blockId, `block ${index}`).toBe(block.id);
    });
  });
});
