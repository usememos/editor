import { describe, expect, it } from 'vitest';
import * as cmd from '../src/commands';
import {
  type Block,
  type EditorState,
  type Inline,
  type Selection,
  caret,
  codeBlock,
  createState,
  divider,
  heading,
  inlineText,
  listItem,
  paragraph,
  plain,
  quote,
  table,
} from '../src/model';
import { footnotes } from '../src/extensions/footnotes';

// Compact text form of a document, for readable assertions:
// "p:hello", "h2:Title", "ul0:item", "ol1:item", "task0[x]:done", "quote:text", "code(js):x", "hr", "table:a|b/c|d".
function show(s: EditorState): string[] {
  return s.doc.blocks.map(describeBlock);
}
function describeBlock(b: Block): string {
  switch (b.type) {
    case 'paragraph':
      return `p:${fmt(b.content)}`;
    case 'heading':
      return `h${b.level}:${fmt(b.content)}`;
    case 'listItem': {
      const kind = b.listType === 'bullet' ? 'ul' : b.listType === 'ordered' ? 'ol' : 'task';
      return `${kind}${b.indent}${b.listType === 'task' ? (b.checked ? '[x]' : '[ ]') : ''}:${fmt(b.content)}`;
    }
    case 'quote':
      return `quote:${fmt(b.content)}`;
    case 'code':
      return `code(${b.language}):${inlineText(b.content)}`;
    case 'raw':
      return `${b.syntax}:${inlineText(b.content)}`;
    case 'divider':
      return 'hr';
    case 'details':
      return `details:${inlineText(b.content)}`;
    case 'detailsEnd':
      return '/details';
    case 'table':
      return `table:${b.rows.map((r) => r.map(fmt).join('|')).join('/')}`;
  }
}
/** Text with marks shown as <b>, <i>, <s>, <c> and links as [text](href). */
function fmt(inline: Inline): string {
  return inline
    .map((s) => {
      let t = s.text;
      if (s.marks.includes('code')) t = `<c>${t}</c>`;
      if (s.marks.includes('strike')) t = `<s>${t}</s>`;
      if (s.marks.includes('italic')) t = `<i>${t}</i>`;
      if (s.marks.includes('bold')) t = `<b>${t}</b>`;
      if (s.link) t = `[${t}](${s.link})`;
      return t;
    })
    .join('');
}

const txt = (text: string) => [{ text, marks: [] as const }];
const bold = (text: string) => [{ text, marks: ['bold'] as const }];

function state(...blocks: Block[]): EditorState {
  return createState({ blocks });
}
function at(s: EditorState, blockIndex: number, offset: number): EditorState {
  return { ...s, selection: caret(s.doc.blocks[blockIndex]!.id, offset) };
}
function range(s: EditorState, a: [number, number], b: [number, number]): EditorState {
  const sel: Selection = {
    anchor: { blockId: s.doc.blocks[a[0]]!.id, offset: a[1] },
    focus: { blockId: s.doc.blocks[b[0]]!.id, offset: b[1] },
  };
  return { ...s, selection: sel };
}
function inCell(s: EditorState, blockIndex: number, row: number, col: number, offset: number): EditorState {
  return { ...s, selection: caret(s.doc.blocks[blockIndex]!.id, offset, { row, col }) };
}
const type = (s: EditorState, text: string) => [...text].reduce((acc, ch) => cmd.insertText(acc, ch), s);

describe('insertText', () => {
  it('inherits marks from the character before the caret', () => {
    const s = cmd.insertText(at(state(paragraph([...bold('bold'), ...txt(' text')])), 0, 4), 'er');
    expect(show(s)).toEqual(['p:<b>bolder</b> text']);
  });

  it('uses stored marks after toggling on a collapsed selection', () => {
    let s = at(state(paragraph(txt('plain'))), 0, 5);
    s = cmd.toggleMark(s, 'italic');
    s = cmd.insertText(s, '!');
    expect(show(s)).toEqual(['p:plain<i>!</i>']);
  });

  it('replaces a selection across blocks', () => {
    const s = cmd.insertText(range(state(paragraph(txt('one')), paragraph(txt('two')), paragraph(txt('three'))), [0, 1], [2, 2]), 'X');
    expect(show(s)).toEqual(['p:oXree']);
  });

  it('does not extend a link when typing at its end, but does inside it', () => {
    const linked = paragraph([{ text: 'site', marks: [], link: 'https://a.b' }]);
    expect(show(cmd.insertText(at(state(linked), 0, 4), 'x'))).toEqual(['p:[site](https://a.b)x']);
    expect(show(cmd.insertText(at(state(linked), 0, 2), 'x'))).toEqual(['p:[sixte](https://a.b)']);
  });

  it('inserts plain text in a code block', () => {
    let s = at(state(codeBlock('js', 'ab')), 0, 1);
    s = cmd.toggleMark(s, 'bold');
    s = cmd.insertText(s, 'X');
    expect(show(s)).toEqual(['code(js):aXb']);
  });

  it('types into a table cell', () => {
    const s = cmd.insertText(inCell(state(table([null, null], [[txt('a'), txt('b')], [[], []]])), 0, 1, 1, 0), 'z');
    expect(show(s)).toEqual(['table:a|b/|z']);
  });
});

describe('splitBlock (Enter)', () => {
  it('splits a paragraph and moves the caret to the new block', () => {
    const s = cmd.splitBlock(at(state(paragraph(txt('hello world'))), 0, 5));
    expect(show(s)).toEqual(['p:hello', 'p: world']);
    expect(s.selection.focus).toEqual({ blockId: s.doc.blocks[1]!.id, offset: 0 });
  });

  it('creates a paragraph after a heading when pressed at the end', () => {
    expect(show(cmd.splitBlock(at(state(heading(1, txt('Title'))), 0, 5)))).toEqual(['h1:Title', 'p:']);
  });

  it('inserts an empty block above when pressed at the start, keeping the block id', () => {
    const before = state(heading(1, txt('Title')));
    const s = cmd.splitBlock(at(before, 0, 0));
    expect(show(s)).toEqual(['p:', 'h1:Title']);
    expect(s.doc.blocks[1]!.id).toBe(before.doc.blocks[0]!.id);
  });

  it('continues a list with the same type and indent', () => {
    const s = cmd.splitBlock(at(state(listItem('task', txt('ab'), { indent: 1, checked: true })), 0, 2));
    expect(show(s)).toEqual(['task1[x]:ab', 'task1[ ]:']);
  });

  it('outdents, then ends, a list on Enter in an empty item', () => {
    let s = at(state(listItem('bullet', [], { indent: 1 })), 0, 0);
    s = cmd.splitBlock(s);
    expect(show(s)).toEqual(['ul0:']);
    s = cmd.splitBlock(s);
    expect(show(s)).toEqual(['p:']);
  });

  it('inserts a newline in a code block, and leaves it after two empty lines', () => {
    let s = at(state(codeBlock('', 'x')), 0, 1);
    s = cmd.splitBlock(s);
    s = cmd.splitBlock(s);
    expect(show(s)).toEqual(['code():x\n\n']);
    s = cmd.splitBlock(s);
    expect(show(s)).toEqual(['code():x', 'p:']);
  });

  it('turns "```ts" + Enter into a code block', () => {
    const s = cmd.splitBlock(at(state(paragraph(txt('```ts'))), 0, 5));
    expect(show(s)).toEqual(['code(ts):']);
  });

  it('moves down a table, adding a row at the bottom', () => {
    const s = cmd.splitBlock(inCell(state(table([null], [[txt('h')], [txt('a')]])), 0, 1, 0, 1));
    expect(show(s)).toEqual(['table:h/a/']);
    expect(s.selection.focus.cell).toEqual({ row: 2, col: 0 });
  });
});

describe('exitBlock (ArrowDown and ArrowUp at the edge of the document)', () => {
  it('adds a paragraph below a final code block from its last line', () => {
    const s = at(state(paragraph(txt('a')), codeBlock('js', 'x\nyz')), 1, 3);
    const next = cmd.exitBlock(s, 1);
    expect(show(next)).toEqual(['p:a', 'code(js):x\nyz', 'p:']);
    expect(next.selection.focus).toEqual({ blockId: next.doc.blocks[2]!.id, offset: 0 });
  });

  it('adds a paragraph above a first code block from its first line', () => {
    const next = cmd.exitBlock(at(state(codeBlock('', 'xy\nz'), paragraph(txt('a'))), 0, 1), -1);
    expect(show(next)).toEqual(['p:', 'code():xy\nz', 'p:a']);
    expect(next.selection.focus.blockId).toBe(next.doc.blocks[0]!.id);
  });

  it('does nothing above the last line, when a block follows, or in other block types', () => {
    const code = state(paragraph(txt('a')), codeBlock('', 'x\ny'));
    const above = at(code, 1, 1);
    expect(cmd.exitBlock(above, 1)).toBe(above);
    const notFirst = at(code, 1, 0);
    expect(cmd.exitBlock(notFirst, -1)).toBe(notFirst);
    const below = at(state(codeBlock('', 'x\ny'), paragraph(txt('a'))), 0, 3);
    expect(cmd.exitBlock(below, -1)).toBe(below);
    const mid = at(state(codeBlock('', 'x'), paragraph(txt('a'))), 0, 1);
    expect(cmd.exitBlock(mid, 1)).toBe(mid);
    const p = at(state(paragraph(txt('a'))), 0, 1);
    expect(cmd.exitBlock(p, 1)).toBe(p);
  });

  it('leaves a table from its last row going down, or its first row going up', () => {
    const t = state(paragraph(txt('a')), table([null, null], [[txt('h'), txt('i')], [txt('b'), txt('cd')]]));
    expect(show(cmd.exitBlock(inCell(t, 1, 1, 0, 0), 1))).toEqual(['p:a', 'table:h|i/b|cd', 'p:']);
    expect(show(cmd.exitBlock(inCell(t, 1, 1, 1, 2), 1))).toEqual(['p:a', 'table:h|i/b|cd', 'p:']);
    expect(cmd.exitBlock(inCell(t, 1, 0, 1, 1), 1).doc).toBe(t.doc);
    const first = state(table([null], [[txt('h')], [txt('b')]]));
    expect(show(cmd.exitBlock(inCell(first, 0, 0, 0, 1), -1))).toEqual(['p:', 'table:h/b']);
    expect(cmd.exitBlock(inCell(first, 0, 1, 0, 0), -1).doc).toBe(first.doc);
  });

  it('leaves a final divider', () => {
    expect(show(cmd.exitBlock(at(state(paragraph(txt('a')), divider()), 1, 0), 1))).toEqual(['p:a', 'hr', 'p:']);
  });
});

describe('insertLineBreak (Shift+Enter)', () => {
  it('inserts a hard break with the current marks', () => {
    const s = cmd.insertLineBreak(at(state(paragraph(bold('ab'))), 0, 1));
    expect(show(s)).toEqual(['p:<b>a\nb</b>']);
  });

  it('does nothing in a table cell', () => {
    const s0 = inCell(state(table([null], [[txt('h')]])), 0, 0, 0, 1);
    expect(cmd.insertLineBreak(s0)).toBe(s0);
  });
});

describe('deleteBackward (Backspace)', () => {
  it('removes a whole emoji', () => {
    const s = cmd.deleteBackward(at(state(paragraph(txt('hi 👍🏽'))), 0, 7));
    expect(show(s)).toEqual(['p:hi ']);
  });

  it('turns a heading into a paragraph at offset 0', () => {
    expect(show(cmd.deleteBackward(at(state(heading(2, txt('Title'))), 0, 0)))).toEqual(['p:Title']);
  });

  it('outdents a nested list item, then turns it into a paragraph', () => {
    let s = at(state(listItem('ordered', txt('x'), { indent: 1 })), 0, 0);
    s = cmd.deleteBackward(s);
    expect(show(s)).toEqual(['ol0:x']);
    s = cmd.deleteBackward(s);
    expect(show(s)).toEqual(['p:x']);
  });

  it('merges a paragraph into the previous block', () => {
    const s = cmd.deleteBackward(at(state(heading(1, txt('One')), paragraph(txt('two'))), 1, 0));
    expect(show(s)).toEqual(['h1:Onetwo']);
    expect(s.selection.focus.offset).toBe(3);
  });

  it('removes a divider above', () => {
    const s = cmd.deleteBackward(at(state(paragraph(txt('a')), divider(), paragraph(txt('b'))), 2, 0));
    expect(show(s)).toEqual(['p:a', 'p:b']);
  });

  it('moves into the last cell of a table above instead of merging', () => {
    const s = cmd.deleteBackward(at(state(table([null], [[txt('h')], [txt('cell')]]), paragraph(txt('x'))), 1, 0));
    expect(show(s)).toEqual(['table:h/cell', 'p:x']);
    expect(s.selection.focus).toMatchObject({ offset: 4, cell: { row: 1, col: 0 } });
  });

  it('does nothing at the very start of the document', () => {
    const s0 = at(state(paragraph(txt('text'))), 0, 0);
    expect(cmd.deleteBackward(s0)).toBe(s0);
  });
});

describe('deleteForward', () => {
  it('merges the next block at the end of a block', () => {
    expect(show(cmd.deleteForward(at(state(paragraph(txt('one')), paragraph(txt('two'))), 0, 3)))).toEqual(['p:onetwo']);
  });
});

describe('deleteRange across non-text blocks', () => {
  it('removes a table that the selection runs into', () => {
    let s = state(paragraph(txt('ab')), table([null], [[txt('h')]]), paragraph(txt('cd')));
    s = { ...s, selection: { anchor: { blockId: s.doc.blocks[0]!.id, offset: 1 }, focus: { blockId: s.doc.blocks[1]!.id, offset: 0, cell: { row: 0, col: 0 } } } };
    expect(show(cmd.deleteSelection(s))).toEqual(['p:a', 'p:cd']);
  });
});

describe('marks and links', () => {
  it('adds a mark across blocks, then removes it', () => {
    let s = range(state(paragraph(txt('one')), paragraph(txt('two'))), [0, 1], [1, 2]);
    s = cmd.toggleMark(s, 'bold');
    expect(show(s)).toEqual(['p:o<b>ne</b>', 'p:<b>tw</b>o']);
    expect(cmd.isMarkActive(s, 'bold')).toBe(true);
    s = cmd.toggleMark(s, 'bold');
    expect(show(s)).toEqual(['p:one', 'p:two']);
  });

  it('sets, edits and removes a link', () => {
    let s = range(state(paragraph(txt('visit site now'))), [0, 6], [0, 10]);
    s = cmd.setLink(s, 'https://x.y');
    expect(show(s)).toEqual(['p:visit [site](https://x.y) now']);
    // Collapsed inside the link: the whole link changes.
    s = cmd.setLink(at(s, 0, 8), 'https://z.z');
    expect(show(s)).toEqual(['p:visit [site](https://z.z) now']);
    s = cmd.setLink(at(s, 0, 8), null);
    expect(show(s)).toEqual(['p:visit site now']);
  });
});

describe('block types', () => {
  it('converts a heading to a list item and back, keeping the id and text', () => {
    const before = at(state(heading(1, txt('x'))), 0, 0);
    const s = cmd.setBlockType(before, { type: 'listItem', listType: 'task' });
    expect(show(s)).toEqual(['task0[ ]:x']);
    expect(s.doc.blocks[0]!.id).toBe(before.doc.blocks[0]!.id);
    expect(show(cmd.setBlockType(s, { type: 'paragraph' }))).toEqual(['p:x']);
  });

  it('drops formatting when converting to code', () => {
    expect(show(cmd.setBlockType(at(state(paragraph(bold('x'))), 0, 0), { type: 'code' }))).toEqual(['code():x']);
  });

  it('converts a text block in place for text types, keeping its text and ID', () => {
    const before = at(state(paragraph(txt('hello'))), 0, 5);
    const s = cmd.insertBlock(before, { type: 'heading', level: 1 });
    expect(show(s)).toEqual(['h1:hello']);
    expect(s.doc.blocks[0]!.id).toBe(before.doc.blocks[0]!.id);
  });

  it('inserts a table below a non-empty block, or replaces an empty one', () => {
    expect(show(cmd.insertBlock(at(state(paragraph(txt('a'))), 0, 1), { type: 'table' }))).toEqual(['p:a', 'table:||/||/||']);
    expect(show(cmd.insertBlock(at(state(paragraph()), 0, 0), { type: 'table' }))).toEqual(['table:||/||/||']);
  });

  it('inserts a divider and moves the caret to a paragraph after it', () => {
    const s = cmd.insertBlock(at(state(paragraph()), 0, 0), { type: 'divider' });
    expect(show(s)).toEqual(['hr', 'p:']);
    expect(s.selection.focus.blockId).toBe(s.doc.blocks[1]!.id);
  });
});

describe('lists', () => {
  it('indents at most one level deeper than the item above', () => {
    let s = state(listItem('bullet', txt('a')), listItem('bullet', txt('b')));
    s = cmd.indentListItems(at(s, 1, 0), 1);
    s = cmd.indentListItems(s, 1);
    expect(show(s)).toEqual(['ul0:a', 'ul1:b']);
    expect(show(cmd.indentListItems(s, -1))).toEqual(['ul0:a', 'ul0:b']);
  });

  it('does not indent the first item', () => {
    const s0 = at(state(listItem('bullet', txt('a'))), 0, 0);
    expect(cmd.indentListItems(s0, 1)).toBe(s0);
  });

  it('toggles a task', () => {
    const s = state(listItem('task', txt('a')));
    expect(show(cmd.toggleTask(s, s.doc.blocks[0]!.id))).toEqual(['task0[x]:a']);
  });
});

describe('block menu', () => {
  it('duplicates and deletes a block', () => {
    let s = state(paragraph(txt('a')), quote(txt('b')));
    s = cmd.duplicateBlock(s, s.doc.blocks[1]!.id);
    expect(show(s)).toEqual(['p:a', 'quote:b', 'quote:b']);
    expect(s.doc.blocks[1]!.id).not.toBe(s.doc.blocks[2]!.id);
    s = cmd.deleteBlock(s, s.doc.blocks[0]!.id);
    expect(show(s)).toEqual(['quote:b', 'quote:b']);
  });

  it('keeps one empty paragraph when the last block is deleted', () => {
    const s = state(divider());
    expect(show(cmd.deleteBlock(s, s.doc.blocks[0]!.id))).toEqual(['p:']);
  });
});

describe('whole blocks (block selection)', () => {
  const doc = () =>
    state(paragraph(txt('intro')), listItem('bullet', txt('a')), listItem('bullet', txt('a1'), { indent: 1 }), listItem('bullet', txt('b')), paragraph(txt('end')));

  it('spanBlocks selects from the start of the first block to the end of the last', () => {
    const s = doc();
    expect(cmd.spanBlocks(s.doc.blocks, { from: 1, to: 3 })).toEqual({
      anchor: { blockId: s.doc.blocks[1]!.id, offset: 0 },
      focus: { blockId: s.doc.blocks[3]!.id, offset: 1 },
    });
  });

  it('spanBlocks covers a table from its first cell to its last', () => {
    const s = state(table([null, null], [[txt('a'), txt('b')], [txt('c'), txt('dd')]]));
    const sel = cmd.spanBlocks(s.doc.blocks, { from: 0, to: 0 });
    expect(sel.anchor.cell).toEqual({ row: 0, col: 0 });
    expect(sel.focus).toMatchObject({ offset: 2, cell: { row: 1, col: 1 } });
  });

  it('deleteBlocks removes whole blocks and puts the caret at the end of the block before', () => {
    const s = cmd.deleteBlocks(doc(), { from: 1, to: 3 });
    expect(show(s)).toEqual(['p:intro', 'p:end']);
    expect(s.selection.focus).toEqual({ blockId: s.doc.blocks[0]!.id, offset: 5 });
  });

  it('deleteBlocks at the start puts the caret at the start of the next block', () => {
    const s = cmd.deleteBlocks(doc(), { from: 0, to: 0 });
    expect(show(s)[0]).toBe('ul0:a');
    expect(s.selection.focus).toEqual({ blockId: s.doc.blocks[0]!.id, offset: 0 });
  });

  it('deleteBlocks of every block leaves one empty paragraph', () => {
    const s = cmd.deleteBlocks(doc(), { from: 0, to: 4 });
    expect(show(s)).toEqual(['p:']);
  });

  it('deleteBlocks lifts nested items whose parent was deleted', () => {
    const s = cmd.deleteBlocks(doc(), { from: 1, to: 1 });
    expect(show(s)).toEqual(['p:intro', 'ul0:a1', 'ul0:b', 'p:end']);
  });

  it('deleteBlocks keeps blocks it did not touch as the same objects', () => {
    const before = doc();
    const s = cmd.deleteBlocks(before, { from: 4, to: 4 });
    s.doc.blocks.forEach((b, i) => expect(b).toBe(before.doc.blocks[i]));
  });

  it('duplicateBlocks inserts copies with new IDs after the range and selects them', () => {
    const before = doc();
    const s = cmd.duplicateBlocks(before, { from: 1, to: 2 });
    expect(show(s)).toEqual(['p:intro', 'ul0:a', 'ul1:a1', 'ul0:a', 'ul1:a1', 'ul0:b', 'p:end']);
    expect(s.doc.blocks[3]!.id).not.toBe(before.doc.blocks[1]!.id);
    expect(s.selection).toEqual(cmd.spanBlocks(s.doc.blocks, { from: 3, to: 4 }));
  });

  it('duplicateBlocks re-nests a copy that would be too deep after the range', () => {
    const s = cmd.duplicateBlocks(doc(), { from: 2, to: 3 });
    expect(show(s)).toEqual(['p:intro', 'ul0:a', 'ul1:a1', 'ul0:b', 'ul1:a1', 'ul0:b', 'p:end']);
  });

  it('replaceBlocks puts pasted blocks in place of the selected ones', () => {
    const s = cmd.replaceBlocks(doc(), { from: 1, to: 3 }, [heading(2, txt('New')), paragraph(txt('text'))]);
    expect(show(s)).toEqual(['p:intro', 'h2:New', 'p:text', 'p:end']);
    expect(s.selection.focus).toEqual({ blockId: s.doc.blocks[2]!.id, offset: 4 });
  });

  it('replaceBlocks re-nests the items after a pasted paragraph', () => {
    const s = cmd.replaceBlocks(doc(), { from: 1, to: 1 }, [paragraph(txt('x'))]);
    expect(show(s)).toEqual(['p:intro', 'p:x', 'ul0:a1', 'ul0:b', 'p:end']);
  });
});

describe('tables', () => {
  const t = () => state(table([null, null], [[txt('a'), txt('b')], [txt('c'), txt('d')]]));

  it('adds and deletes rows and columns', () => {
    let s = cmd.tableAction(inCell(t(), 0, 1, 0, 0), { kind: 'addRowBelow' });
    expect(show(s)).toEqual(['table:a|b/c|d/|']);
    s = cmd.tableAction(s, { kind: 'addColumnRight' });
    expect(show(s)).toEqual(['table:a||b/c||d/||']);
    s = cmd.tableAction(s, { kind: 'deleteColumn' });
    s = cmd.tableAction(s, { kind: 'deleteRow' });
    expect(show(s)).toEqual(['table:a|b/c|d']);
  });

  it('keeps the header row first when adding a row above it', () => {
    expect(show(cmd.tableAction(inCell(t(), 0, 0, 0, 0), { kind: 'addRowAbove' }))).toEqual(['table:a|b/|/c|d']);
  });

  it('sets column alignment', () => {
    const s = cmd.tableAction(inCell(t(), 0, 0, 1, 0), { kind: 'align', align: 'center' });
    expect((s.doc.blocks[0] as unknown as { align: unknown[] }).align).toEqual([null, 'center']);
  });

  it('Tab moves to the next cell and adds a row after the last one', () => {
    let s = cmd.moveCell(inCell(t(), 0, 1, 1, 0), 1);
    expect(show(s)).toEqual(['table:a|b/c|d/|']);
    expect(s.selection.focus.cell).toEqual({ row: 2, col: 0 });
    s = cmd.moveCell(s, -1);
    expect(s.selection.focus.cell).toEqual({ row: 1, col: 1 });
  });
});

describe('block shortcuts', () => {
  const typed = (text: string) => {
    let s = at(state(paragraph()), 0, 0);
    for (const ch of text) {
      s = cmd.insertText(s, ch);
      if (ch === ' ' || ch === '-') s = cmd.applyBlockInputRules(s) ?? s;
    }
    return show(s);
  };

  it.each([
    ['## Hi', ['h2:Hi']],
    ['- item', ['ul0:item']],
    ['* item', ['ul0:item']],
    ['1. item', ['ol0:item']],
    ['[ ] todo', ['task0[ ]:todo']],
    ['[x] done', ['task0[x]:done']],
    ['- [ ] todo', ['task0[ ]:todo']],
    ['> quoted', ['quote:quoted']],
    ['``` x', ['code():x']],
    ['---', ['hr', 'p:']],
  ])('%s', (input, expected) => {
    expect(typed(input)).toEqual(expected);
  });

  it('keeps the start number of an ordered list', () => {
    let s = at(state(paragraph()), 0, 0);
    s = type(s, '3. ');
    s = cmd.applyBlockInputRules(s)!;
    expect((s.doc.blocks[0] as { start?: number }).start).toBe(3);
  });

  it('does not apply in the middle of text', () => {
    const s = cmd.insertText(at(state(paragraph(txt('a#'))), 0, 2), ' ');
    expect(cmd.applyBlockInputRules(s)).toBeNull();
  });
});

describe('inline shortcuts', () => {
  const typed = (text: string) => {
    let s = at(state(paragraph()), 0, 0);
    for (const ch of text) {
      s = cmd.insertText(s, ch);
      if ('*_`~'.includes(ch)) s = cmd.applyInlineInputRules(s) ?? s;
    }
    return show(s);
  };

  it.each([
    ['a **bold** b', ['p:a <b>bold</b> b']],
    ['a __bold__ b', ['p:a <b>bold</b> b']],
    ['a *it* b', ['p:a <i>it</i> b']],
    ['a _it_ b', ['p:a <i>it</i> b']],
    ['a `code` b', ['p:a <c>code</c> b']],
    ['a ~~gone~~ b', ['p:a <s>gone</s> b']],
    ['snake_case_name', ['p:snake_case_name']],
    ['2 * 3 * 4', ['p:2 * 3 * 4']],
    // A backslash escapes a delimiter, as in CommonMark; inside code it is literal.
    ['\\*a*', ['p:\\*a*']],
    ['*a\\*', ['p:*a\\*']],
    ['\\**a**', ['p:\\**a**']],
    ['\\\\*a*', ['p:\\\\<i>a</i>']],
    ['\\`a`', ['p:\\`a`']],
    ['`a\\`', ['p:<c>a\\</c>']],
  ])('%s', (input, expected) => {
    expect(typed(input)).toEqual(expected);
  });
});

describe('insertBlocks (paste)', () => {
  it('merges a single pasted paragraph inline', () => {
    const s = cmd.insertBlocks(at(state(paragraph(txt('ab'))), 0, 1), [paragraph(bold('X'))]);
    expect(show(s)).toEqual(['p:a<b>X</b>b']);
  });

  it('splits around several pasted blocks', () => {
    const s = cmd.insertBlocks(at(state(paragraph(txt('ab'))), 0, 1), [paragraph(txt('one')), heading(2, txt('two')), paragraph(txt('three'))]);
    expect(show(s)).toEqual(['p:aone', 'h2:two', 'p:threeb']);
  });

  it('pastes a table between the two halves of a paragraph', () => {
    const s = cmd.insertBlocks(at(state(paragraph(txt('ab'))), 0, 1), [table([null], [[txt('h')]])]);
    expect(show(s)).toEqual(['p:a', 'table:h', 'p:b']);
  });

  it('pastes as plain text inside a code block', () => {
    const s = cmd.insertBlocks(at(state(codeBlock('', '')), 0, 0), [paragraph(bold('x')), paragraph(txt('y'))]);
    expect(show(s)).toEqual(['code():x\ny']);
  });

  it('replaces an empty block with the pasted block type', () => {
    expect(show(cmd.insertBlocks(at(state(paragraph()), 0, 0), [heading(1, txt('T'))]))).toEqual(['h1:T']);
  });
});

describe('toggleBlockType', () => {
  it('sets the type, and turns blocks back into paragraphs when they all have it', () => {
    const p1 = paragraph(plain('a'));
    const p2 = heading(2, plain('b'));
    let s: EditorState = { ...createState({ blocks: [p1, p2] }), selection: { anchor: caret(p1.id, 0).anchor, focus: caret(p2.id, 1).focus } };
    s = cmd.toggleBlockType(s, { type: 'heading', level: 2 });
    expect(show(s)).toEqual(['h2:a', 'h2:b']);
    s = cmd.toggleBlockType(s, { type: 'heading', level: 2 });
    expect(show(s)).toEqual(['p:a', 'p:b']);
    s = cmd.toggleBlockType(s, { type: 'listItem', listType: 'task' });
    expect(show(s)).toEqual(['task0[ ]:a', 'task0[ ]:b']);
  });

  it('turns several blocks into one code block, a line per block, and selects it', () => {
    const p1 = paragraph(bold('a'));
    const p2 = listItem('bullet', plain('b'));
    const p3 = heading(2, plain('c'));
    const s0: EditorState = { ...createState({ blocks: [p1, p2, p3] }), selection: { anchor: caret(p3.id, 1).anchor, focus: caret(p1.id, 0).focus } };
    const s = cmd.toggleBlockType(s0, { type: 'code' });
    expect(show(s)).toEqual(['code():a\nb\nc']);
    expect(s.doc.blocks[0]!.id).toBe(p1.id);
    expect(s.selection).toEqual({ anchor: { blockId: p1.id, offset: 0 }, focus: { blockId: p1.id, offset: 5 } });
  });

  it('keeps tables and dividers out of a merged code block', () => {
    const blocks = [paragraph(plain('a')), divider(), paragraph(plain('b')), paragraph(plain('c'))];
    const s0: EditorState = { ...createState({ blocks }), selection: { anchor: caret(blocks[0]!.id, 0).anchor, focus: caret(blocks[3]!.id, 1).focus } };
    const s = cmd.setBlockType(s0, { type: 'code', language: 'js' });
    expect(show(s)).toEqual(['code(js):a', 'hr', 'code(js):b\nc']);
    expect(s.selection.focus).toEqual({ blockId: blocks[2]!.id, offset: 3 });
  });
});

describe('insertFragment', () => {
  const frag = (...blocks: Block[]) => blocks;

  it('inserts a single paragraph inline at the selection, like a paste', () => {
    const p = paragraph(plain('hello world'));
    const s = cmd.insertFragment(stateAt([p], caret(p.id, 6)), frag(paragraph(plain('big '))));
    expect(show(s)).toEqual(['p:hello big world']);
    expect(s.selection.focus.offset).toBe(10);
  });

  it('inserts as its own block at a position, keeping the selected text and the selection', () => {
    const p = paragraph(plain('hello world'));
    const sel: Selection = { anchor: { blockId: p.id, offset: 0 }, focus: { blockId: p.id, offset: 11 } };
    const s = cmd.insertFragment(stateAt([p], sel), frag(paragraph(plain('X'))), {
      at: { blockId: p.id, offset: 5 },
      block: true,
      select: 'keep',
    });
    expect(show(s)).toEqual(['p:hello', 'p:X', 'p: world']);
    expect(s.selection.anchor).toEqual({ blockId: p.id, offset: 0 });
    expect(s.selection.focus).toEqual({ blockId: s.doc.blocks[2]!.id, offset: 6 });
  });

  it('inserts blocks before or after a block when the position is at its edge, and replaces an empty paragraph', () => {
    const p = paragraph(plain('ab'));
    const empty = paragraph();
    const at = (offset: number) => cmd.insertFragment(stateAt([p, empty], caret(p.id, 0)), frag(paragraph(plain('X'))), { at: { blockId: p.id, offset }, block: true });
    expect(show(at(0))).toEqual(['p:X', 'p:ab', 'p:']);
    expect(show(at(2))).toEqual(['p:ab', 'p:X', 'p:']);
    const s = cmd.insertFragment(stateAt([p, empty], caret(empty.id, 0)), frag(paragraph(plain('X'))), { block: true });
    expect(show(s)).toEqual(['p:ab', 'p:X']);
  });

  it("appends at 'end', after a code block, and puts the caret at the end of the insertion", () => {
    const c = codeBlock('js', 'x');
    const s = cmd.insertFragment(stateAt([c], caret(c.id, 0)), frag(paragraph(plain('a')), paragraph(plain('bc'))), { at: 'end' });
    expect(show(s)).toEqual(['code(js):x', 'p:a', 'p:bc']);
    expect(s.selection.focus).toEqual({ blockId: s.doc.blocks[2]!.id, offset: 2 });
  });
});

describe('selectAll', () => {
  it('selects from the start of the first block to the end of the last', () => {
    const a = paragraph(plain('a'));
    const b = paragraph(plain('bcd'));
    const s = cmd.selectAll(stateAt([a, b], caret(a.id, 1)));
    expect(s.selection).toEqual({ anchor: { blockId: a.id, offset: 0 }, focus: { blockId: b.id, offset: 3 } });
  });
});

function stateAt(blocks: Block[], selection: Selection): EditorState {
  return { ...createState({ blocks }), selection };
}

describe('dropBrokenTokens', () => {
  const syntax = footnotes().markdown!.inline!;
  const tokens = (s: EditorState) =>
    s.doc.blocks.map((b) => ('content' in b ? b.content.map((x) => (x.token ? `{${x.text}}` : x.text)).join('') : ''));
  const withToken = (text: string, from: number, to: number) =>
    state(paragraph([{ text: text.slice(0, from), marks: [] }, { text: text.slice(from, to), marks: [], token: 'footnote' }, { text: text.slice(to), marks: [] }]));

  it('removes the token from text that no longer reads as its syntax', () => {
    const before = withToken('a[^1] b', 1, 5);
    const edited = cmd.deleteRange(before, { blockId: before.doc.blocks[0]!.id, offset: 1 }, { blockId: before.doc.blocks[0]!.id, offset: 2 });
    expect(tokens(edited)).toEqual(['a{^1]} b']);
    expect(tokens(cmd.dropBrokenTokens(edited, before, syntax))).toEqual(['a^1] b']);
  });

  it('keeps valid tokens, several in one run, and blocks that did not change', () => {
    const before = withToken('a[^1][^2] b', 1, 9);
    const other = { ...before, doc: { blocks: [...before.doc.blocks] } };
    expect(cmd.dropBrokenTokens(other, before, syntax)).toBe(other);
    const changed = cmd.insertText(at(before, 0, 11), '!');
    expect(tokens(cmd.dropBrokenTokens(changed, before, syntax))).toEqual(['a{[^1][^2]} b!']);
  });

  it('removes the token from text marked as code', () => {
    const before = withToken('a[^1] b', 1, 5);
    const coded = cmd.toggleMark(range(before, [0, 0], [0, 7]), 'code');
    expect(tokens(coded)).toEqual(['a{[^1]} b']);
    expect(tokens(cmd.dropBrokenTokens(coded, before, syntax))).toEqual(['a[^1] b']);
  });
});

describe('clampListIndents', () => {
  const doc = (...blocks: Block[]) => state(...blocks);

  it('lowers an item nested deeper than the block above allows', () => {
    const before = doc(paragraph(plain('p')), listItem('bullet', plain('a'), { indent: 1 }), listItem('bullet', plain('b'), { indent: 2 }));
    const edited = { ...before, doc: { blocks: [...before.doc.blocks] } };
    expect(show(cmd.clampListIndents(edited, before))).toEqual(['p:p', 'ul0:a', 'ul1:b']);
  });

  it('keeps items one level below their parent, and the same state when nothing is too deep', () => {
    const before = doc(listItem('bullet', plain('a')), listItem('bullet', plain('b'), { indent: 1 }), listItem('task', plain('c'), { indent: 2 }), listItem('bullet', plain('d')));
    const edited = { ...before, doc: { blocks: [...before.doc.blocks] } };
    expect(cmd.clampListIndents(edited, before)).toBe(edited);
  });
});

describe('indentCode', () => {
  const offsets = (s: EditorState) => [s.selection.anchor.offset, s.selection.focus.offset];

  it('inserts two spaces at a caret', () => {
    const s = cmd.indentCode(at(state(codeBlock('js', 'ab')), 0, 1), 1);
    expect(show(s)).toEqual(['code(js):a  b']);
    expect(offsets(s)).toEqual([3, 3]);
  });

  it('indents and outdents every line a selection touches, keeping the selection on the same text', () => {
    let s = range(state(codeBlock('js', 'one\ntwo\nthree')), [0, 1], [0, 5]);
    s = cmd.indentCode(s, 1);
    expect(show(s)).toEqual(['code(js):  one\n  two\nthree']);
    expect(offsets(s)).toEqual([3, 9]);
    s = cmd.indentCode(s, -1);
    expect(show(s)).toEqual(['code(js):one\ntwo\nthree']);
    expect(offsets(s)).toEqual([1, 5]);
  });

  it('outdents up to two spaces or one tab, and does nothing without indentation', () => {
    const s = at(state(codeBlock('', '   a\n\tb')), 0, 4);
    expect(show(cmd.indentCode(s, -1))).toEqual(['code(): a\n\tb']);
    const t = range(state(codeBlock('', 'a\n\tb')), [0, 0], [0, 4]);
    expect(show(cmd.indentCode(t, -1))).toEqual(['code():a\nb']);
    const none = at(state(codeBlock('', 'a')), 0, 1);
    expect(cmd.indentCode(none, -1)).toBe(none);
  });

  it('only acts in a code block', () => {
    const s = at(state(paragraph(plain('a'))), 0, 1);
    expect(cmd.indentCode(s, 1)).toBe(s);
  });
});
