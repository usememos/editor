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

describe('lists', () => {
  const enter = (marked: string) => show(src.sourceEnter(state(marked)));
  const tab = (marked: string, delta: 1 | -1 = 1) => {
    const out = src.sourceIndentList(state(marked), delta);
    return out ? show(out) : null;
  };

  it('continues bullet, ordered and task items', () => {
    expect(enter('- a|')).toBe('- a\n- |');
    expect(enter('* a|\n')).toBe('* a\n* |\n');
    expect(enter('+ a|')).toBe('+ a\n+ |');
    expect(enter('1. a|')).toBe('1. a\n2. |');
    expect(enter('7) a|')).toBe('7) a\n8) |');
    expect(enter('- [x] done|')).toBe('- [x] done\n- [ ] |');
    expect(enter('- [ ] todo|')).toBe('- [ ] todo\n- [ ] |');
    expect(enter('  - nested|')).toBe('  - nested\n  - |');
    expect(enter('> - quoted|')).toBe('> - quoted\n> - |');
    expect(enter('-   wide|')).toBe('-   wide\n-   |');
  });

  it('splits an item at the caret and replaces a selection', () => {
    expect(enter('- ab|cd')).toBe('- ab\n- |cd');
    expect(enter('- ab| cd')).toBe('- ab\n- |cd');
    expect(enter('- a[bc]d')).toBe('- a\n- |d');
    expect(enter('- [ ] ab|cd')).toBe('- [ ] ab\n- [ ] |cd');
  });

  it('numbers the items after a new ordered item', () => {
    expect(enter('1. a|\n2. b\n3. c')).toBe('1. a\n2. |\n3. b\n4. c');
    expect(enter('1. a\n2. b|\n3. c')).toBe('1. a\n2. b\n3. |\n4. c');
    // A list numbered 1., 1., 1. keeps that style.
    expect(enter('1. a|\n1. b\n1. c')).toBe('1. a\n1. |\n1. b\n1. c');
    // A nested list is numbered on its own.
    expect(enter('1. a\n   1. x|\n2. b')).toBe('1. a\n   1. x\n   2. |\n2. b');
  });

  it('ends the list on an empty item, and outdents an empty nested item', () => {
    expect(enter('- a\n- |')).toBe('- a\n|');
    expect(enter('- a\n- [ ] |')).toBe('- a\n|');
    // A marker with no space after it is not continued or removed: `2023.` or a lone `-` may be text.
    expect(enter('- a\n-|')).toBe('- a\n-\n|');
    expect(enter('> - a\n> - |')).toBe('> - a\n> |');
    expect(enter('- a\n  - |')).toBe('- a\n- |');
    expect(enter('1. a\n   1. |\n2. b')).toBe('1. a\n2. |\n3. b');
  });

  it('inserts a plain line break outside lists, before a marker and in fenced code', () => {
    expect(enter('text|')).toBe('text\n|');
    expect(enter('|- a')).toBe('\n|- a');
    expect(enter('-| a')).toBe('-\n| a');
    expect(enter('```\n- a|\n```')).toBe('```\n- a\n|\n```');
    expect(enter('> ```\n> - a|')).toBe('> ```\n> - a\n|');
    expect(enter('* * *|')).toBe('* * *\n|');
    expect(enter('2023.|')).toBe('2023.\n|');
    expect(enter('#tag|')).toBe('#tag\n|');
  });

  it('nests an item under the one before it, at that item\'s text column', () => {
    expect(tab('- a\n- b|')).toBe('- a\n  - b|');
    expect(tab('- a\n- |b')).toBe('- a\n  - |b');
    expect(tab('1. a\n2. b|')).toBe('1. a\n   1. b|');
    expect(tab('10. a\n11. b|')).toBe('10. a\n    1. b|');
    expect(tab('- [ ] a\n- [ ] b|')).toBe('- [ ] a\n  - [ ] b|');
    expect(tab('> - a\n> - b|')).toBe('> - a\n>   - b|');
    // Under the previous item's last nested item, numbered after it.
    expect(tab('1. a\n   1. x\n2. b|')).toBe('1. a\n   1. x\n   2. b|');
  });

  it('numbers the list an item left and the one it joined', () => {
    expect(tab('1. a\n2. b|\n3. c')).toBe('1. a\n   1. b|\n2. c');
    expect(tab('1. a\n   1. b|\n2. c', -1)).toBe('1. a\n2. b|\n3. c');
    // Items after an outdented item become its nested items.
    expect(tab('1. a\n   1. b|\n   2. c', -1)).toBe('1. a\n2. b|\n   1. c');
  });

  it('moves the lines nested under an item with it', () => {
    expect(tab('- a\n- b|\n  - c\n- d')).toBe('- a\n  - b|\n    - c\n- d');
    expect(tab('- a\n  - b|\n    - c', -1)).toBe('- a\n- b|\n  - c');
    // Blank lines inside stay empty.
    expect(tab('- a\n- b|\n\n  more\n- c')).toBe('- a\n  - b|\n\n    more\n- c');
  });

  it('moves every selected item', () => {
    expect(tab('- a\n[- b\n- c]')).toBe('- a\n  [- b\n  - c]');
    expect(tab('- a\n  [- b\n  - c]', -1)).toBe('- a\n[- b\n- c]');
    // A selection ending at the start of a line leaves that line.
    expect(tab('- a\n[- b\n]- c')).toBe('- a\n  [- b\n]- c');
  });

  it('keeps an item that cannot move, and leaves other lines to code indenting', () => {
    expect(tab('- a|')).toBe('- a|');
    expect(tab('- a|', -1)).toBe('- a|');
    expect(tab('para\n- a|')).toBe('para\n- a|');
    expect(tab('  - a|', -1)).toBe('- a|');
    expect(tab('text|')).toBeNull();
    expect(tab('```\n- a|\n```')).toBeNull();
    expect(tab('- a\n[- b\ntext]')).toBeNull();
  });
});
