import { describe, expect, it } from 'vitest';
import {
  type EditorState,
  caret,
  commands as cmd,
  createState,
  inlineText,
  parseMarkdown,
  serializeMarkdown,
} from '../src/index';

function state(md: string): EditorState {
  return createState(parseMarkdown(md));
}
function at(s: EditorState, blockIndex: number, offset: number): EditorState {
  return { ...s, selection: caret(s.doc.blocks[blockIndex]!.id, offset) };
}
function range(s: EditorState, a: [number, number], b: [number, number]): EditorState {
  return {
    ...s,
    selection: {
      anchor: { blockId: s.doc.blocks[a[0]]!.id, offset: a[1] },
      focus: { blockId: s.doc.blocks[b[0]]!.id, offset: b[1] },
    },
  };
}
const md = (s: EditorState) => serializeMarkdown(s.doc);

describe('insertText', () => {
  it('inherits marks from the character before the caret', () => {
    const s = cmd.insertText(at(state('**bold** text'), 0, 4), 'er');
    expect(md(s)).toBe('**bolder** text\n');
  });

  it('uses stored marks after toggling on a collapsed selection', () => {
    let s = at(state('plain'), 0, 5);
    s = cmd.toggleMark(s, 'italic');
    s = cmd.insertText(s, '!');
    expect(md(s)).toBe('plain*!*\n');
  });

  it('replaces a selection across blocks', () => {
    const s = cmd.insertText(range(state('one\n\ntwo\n\nthree'), [0, 1], [2, 2]), 'X');
    expect(md(s)).toBe('oXree\n');
  });
});

describe('splitBlock (Enter)', () => {
  it('splits a paragraph and moves the caret to the new block', () => {
    const s = cmd.splitBlock(at(state('hello world'), 0, 5));
    expect(s.doc.blocks.map((b) => inlineText(b.content))).toEqual(['hello', ' world']);
    expect(s.selection.focus).toEqual({ blockId: s.doc.blocks[1]!.id, offset: 0 });
  });

  it('creates a paragraph after a heading when pressed at the end', () => {
    const s = cmd.splitBlock(at(state('# Title'), 0, 5));
    expect(s.doc.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph']);
  });

  it('inserts an empty paragraph above when pressed at the start, keeping the block id', () => {
    const before = state('# Title');
    const s = cmd.splitBlock(at(before, 0, 0));
    expect(s.doc.blocks.map((b) => b.type)).toEqual(['paragraph', 'heading']);
    expect(s.doc.blocks[1]!.id).toBe(before.doc.blocks[0]!.id);
  });
});

describe('deleteBackward (Backspace)', () => {
  it('removes a whole emoji', () => {
    const s = cmd.deleteBackward(at(state('hi 👍🏽'), 0, 7));
    expect(inlineText(s.doc.blocks[0]!.content)).toBe('hi ');
  });

  it('turns a heading into a paragraph at offset 0', () => {
    const s = cmd.deleteBackward(at(state('# Title'), 0, 0));
    expect(md(s)).toBe('Title\n');
  });

  it('merges a paragraph into the previous block', () => {
    const s = cmd.deleteBackward(at(state('# One\n\ntwo'), 1, 0));
    expect(md(s)).toBe('# Onetwo\n');
    expect(s.selection.focus.offset).toBe(3);
  });

  it('does nothing at the very start of the document', () => {
    const s0 = at(state('text'), 0, 0);
    expect(cmd.deleteBackward(s0)).toBe(s0);
  });
});

describe('deleteForward', () => {
  it('merges the next block at the end of a block', () => {
    const s = cmd.deleteForward(at(state('one\n\ntwo'), 0, 3));
    expect(md(s)).toBe('onetwo\n');
  });
});

describe('toggleMark', () => {
  it('adds a mark across blocks, then removes it', () => {
    let s = range(state('one\n\ntwo'), [0, 1], [1, 2]);
    s = cmd.toggleMark(s, 'bold');
    expect(md(s)).toBe('o**ne**\n\n**tw**o\n');
    s = cmd.toggleMark(s, 'bold');
    expect(md(s)).toBe('one\n\ntwo\n');
  });
});

describe('input rules', () => {
  it('turns "## " into a level 2 heading', () => {
    let s = at(state(''), 0, 0);
    s = cmd.insertText(s, '##');
    s = cmd.insertText(s, ' ');
    s = cmd.applyInputRules(s)!;
    s = cmd.insertText(s, 'Hi');
    expect(md(s)).toBe('## Hi\n');
  });
});

describe('insertBlocks (paste)', () => {
  it('merges a single pasted paragraph inline', () => {
    const s = cmd.insertBlocks(at(state('ab'), 0, 1), parseMarkdown('**X**').blocks);
    expect(md(s)).toBe('a**X**b\n');
  });

  it('splits around several pasted blocks', () => {
    const s = cmd.insertBlocks(at(state('ab'), 0, 1), parseMarkdown('one\n\n# two\n\nthree').blocks);
    expect(md(s)).toBe('aone\n\n# two\n\nthreeb\n');
  });
});
