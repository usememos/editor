// Editing commands. Each command is a pure function from state to state, so
// it can be unit tested without a DOM. The view maps browser input to these.

import {
  type Block,
  type EditorState,
  type HeadingBlock,
  type Mark,
  type Position,
  blockIndex,
  caret,
  concatInline,
  deleteInline,
  getBlock,
  heading,
  inlineLength,
  inlineText,
  insertInline,
  isCollapsed,
  marksAt,
  orderedRange,
  paragraph,
  rangeHasMark,
  setMarkInRange,
  sliceInline,
  sortMarks,
  withContent,
} from './model';

function replaceBlocks(state: EditorState, start: number, deleteCount: number, ...blocks: Block[]): Block[] {
  const next = state.doc.blocks.slice();
  next.splice(start, deleteCount, ...blocks);
  return next;
}

/** Deletes everything between two positions (in document order) and joins the boundary blocks. */
export function deleteRange(state: EditorState, from: Position, to: Position): EditorState {
  const fromIndex = blockIndex(state.doc, from.blockId);
  const toIndex = blockIndex(state.doc, to.blockId);
  const fromBlock = state.doc.blocks[fromIndex]!;
  const toBlock = state.doc.blocks[toIndex]!;
  const content =
    fromIndex === toIndex
      ? deleteInline(fromBlock.content, from.offset, to.offset)
      : concatInline(sliceInline(fromBlock.content, 0, from.offset), sliceInline(toBlock.content, to.offset));
  return {
    doc: { blocks: replaceBlocks(state, fromIndex, toIndex - fromIndex + 1, withContent(fromBlock, content)) },
    selection: caret(from.blockId, from.offset),
    storedMarks: null,
  };
}

export function deleteSelection(state: EditorState): EditorState {
  if (isCollapsed(state.selection)) return state;
  const { from, to } = orderedRange(state.doc, state.selection);
  return deleteRange(state, from, to);
}

export function insertText(state: EditorState, text: string): EditorState {
  const marksBefore = state.storedMarks;
  const s = deleteSelection(state);
  const { blockId, offset } = s.selection.focus;
  const block = getBlock(s.doc, blockId);
  const marks = marksBefore ?? marksAt(block.content, offset);
  const content = insertInline(block.content, offset, text, marks);
  const index = blockIndex(s.doc, blockId);
  return {
    doc: { blocks: replaceBlocks(s, index, 1, withContent(block, content)) },
    selection: caret(blockId, offset + text.length),
    storedMarks: null,
  };
}

/** Enter. Splits the block at the caret. */
export function splitBlock(state: EditorState): EditorState {
  const s = deleteSelection(state);
  const { blockId, offset } = s.selection.focus;
  const index = blockIndex(s.doc, blockId);
  const block = s.doc.blocks[index]!;
  const length = inlineLength(block.content);

  // Enter at the start of a non-empty block inserts an empty paragraph above
  // and keeps the caret (and the block type) where it is.
  if (offset === 0 && length > 0) {
    return { ...s, doc: { blocks: replaceBlocks(s, index, 0, paragraph()) }, storedMarks: null };
  }

  const left = withContent(block, sliceInline(block.content, 0, offset));
  const rightContent = sliceInline(block.content, offset);
  // The new block keeps the type when it carries text (splitting a heading in
  // the middle gives two headings) and becomes a paragraph when it is empty.
  const right: Block =
    rightContent.length > 0 && block.type === 'heading' ? heading(block.level, rightContent) : paragraph(rightContent);
  return {
    doc: { blocks: replaceBlocks(s, index, 1, left, right) },
    selection: caret(right.id, 0),
    storedMarks: null,
  };
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter() : null;

/** Offset of the grapheme boundary before `offset`, so Backspace removes a whole emoji. */
export function previousGrapheme(text: string, offset: number): number {
  if (!segmenter) return Math.max(0, offset - 1);
  let last = 0;
  for (const { index } of segmenter.segment(text)) {
    if (index >= offset) break;
    last = index;
  }
  return last;
}

export function nextGrapheme(text: string, offset: number): number {
  if (!segmenter) return Math.min(text.length, offset + 1);
  for (const { index, segment } of segmenter.segment(text)) {
    if (index + segment.length > offset) return index + segment.length;
  }
  return text.length;
}

/** Backspace. */
export function deleteBackward(state: EditorState): EditorState {
  if (!isCollapsed(state.selection)) return deleteSelection(state);
  const { blockId, offset } = state.selection.focus;
  const index = blockIndex(state.doc, blockId);
  const block = state.doc.blocks[index]!;

  if (offset > 0) {
    const from = previousGrapheme(inlineText(block.content), offset);
    return deleteRange(state, { blockId, offset: from }, { blockId, offset });
  }
  // At the start of a styled block, the first Backspace removes the style.
  if (block.type !== 'paragraph') {
    return setBlockType(state, 'paragraph');
  }
  const prev = state.doc.blocks[index - 1];
  if (!prev) return state;
  return deleteRange(state, { blockId: prev.id, offset: inlineLength(prev.content) }, { blockId, offset: 0 });
}

/** Delete (forward). */
export function deleteForward(state: EditorState): EditorState {
  if (!isCollapsed(state.selection)) return deleteSelection(state);
  const { blockId, offset } = state.selection.focus;
  const index = blockIndex(state.doc, blockId);
  const block = state.doc.blocks[index]!;
  const text = inlineText(block.content);
  if (offset < text.length) {
    return deleteRange(state, { blockId, offset }, { blockId, offset: nextGrapheme(text, offset) });
  }
  const next = state.doc.blocks[index + 1];
  if (!next) return state;
  return deleteRange(state, { blockId, offset }, { blockId: next.id, offset: 0 });
}

export function toggleMark(state: EditorState, mark: Mark): EditorState {
  const { from, to } = orderedRange(state.doc, state.selection);
  if (isCollapsed(state.selection)) {
    const block = getBlock(state.doc, from.blockId);
    const current = state.storedMarks ?? marksAt(block.content, from.offset);
    const next = current.includes(mark) ? current.filter((m) => m !== mark) : sortMarks([...current, mark]);
    return { ...state, storedMarks: next };
  }
  const start = blockIndex(state.doc, from.blockId);
  const end = blockIndex(state.doc, to.blockId);
  const ranges = state.doc.blocks.slice(start, end + 1).map((block) => {
    const a = block.id === from.blockId ? from.offset : 0;
    const b = block.id === to.blockId ? to.offset : inlineLength(block.content);
    return { block, a, b };
  });
  const nonEmpty = ranges.filter((r) => r.a < r.b);
  const allHave = nonEmpty.length > 0 && nonEmpty.every((r) => rangeHasMark(r.block.content, r.a, r.b, mark));
  const updated = ranges.map((r) => (r.a < r.b ? withContent(r.block, setMarkInRange(r.block.content, r.a, r.b, mark, !allHave)) : r.block));
  return { ...state, doc: { blocks: replaceBlocks(state, start, updated.length, ...updated) }, storedMarks: null };
}

export type BlockTypeSpec = { type: 'paragraph' } | { type: 'heading'; level: HeadingBlock['level'] };

/** Changes the type of every block touched by the selection. Text and IDs are kept. */
export function setBlockType(state: EditorState, spec: BlockTypeSpec | 'paragraph'): EditorState {
  const target: BlockTypeSpec = spec === 'paragraph' ? { type: 'paragraph' } : spec;
  const { from, to } = orderedRange(state.doc, state.selection);
  const start = blockIndex(state.doc, from.blockId);
  const end = blockIndex(state.doc, to.blockId);
  const updated = state.doc.blocks
    .slice(start, end + 1)
    .map((b) => (target.type === 'paragraph' ? paragraph(b.content, b.id) : heading(target.level, b.content, b.id)));
  return { ...state, doc: { blocks: replaceBlocks(state, start, updated.length, ...updated) } };
}

/**
 * Markdown shortcuts typed at the start of a paragraph, e.g. "## " turns the
 * paragraph into a level 2 heading. Runs after a space is typed.
 */
export function applyInputRules(state: EditorState): EditorState | null {
  if (!isCollapsed(state.selection)) return null;
  const { blockId, offset } = state.selection.focus;
  const block = getBlock(state.doc, blockId);
  if (block.type !== 'paragraph') return null;
  const before = inlineText(block.content).slice(0, offset);
  const match = /^(#{1,6}) $/.exec(before);
  if (!match) return null;
  const level = match[1]!.length as HeadingBlock['level'];
  const stripped = deleteRange(state, { blockId, offset: 0 }, { blockId, offset });
  return setBlockType(stripped, { type: 'heading', level });
}

/**
 * Pastes parsed blocks at the selection. A single pasted block is merged
 * into the current block as inline content. With several blocks, the first
 * joins the text before the caret, the last joins the text after it, and the
 * rest are inserted in between.
 */
export function insertBlocks(state: EditorState, fragment: readonly Block[]): EditorState {
  if (fragment.length === 0) return deleteSelection(state);
  const s = deleteSelection(state);
  const { blockId, offset } = s.selection.focus;
  const index = blockIndex(s.doc, blockId);
  const block = s.doc.blocks[index]!;
  const before = sliceInline(block.content, 0, offset);
  const after = sliceInline(block.content, offset);

  if (fragment.length === 1) {
    const only = fragment[0]!;
    const target = inlineLength(block.content) === 0 ? { ...only, id: block.id } : block;
    const content = concatInline(before, only.content, after);
    return {
      doc: { blocks: replaceBlocks(s, index, 1, withContent(target, content)) },
      selection: caret(block.id, offset + inlineLength(only.content)),
      storedMarks: null,
    };
  }

  const first = fragment[0]!;
  const last = fragment[fragment.length - 1]!;
  const head = before.length === 0 ? { ...first, id: block.id } : withContent(block, concatInline(before, first.content));
  const tail = withContent(last, concatInline(last.content, after));
  const middle = fragment.slice(1, -1);
  return {
    doc: { blocks: replaceBlocks(s, index, 1, head, ...middle, tail) },
    selection: caret(tail.id, inlineLength(last.content)),
    storedMarks: null,
  };
}

/** The selected content as standalone blocks with fresh IDs, for copy and cut. */
export function selectedBlocks(state: EditorState): Block[] {
  const { from, to } = orderedRange(state.doc, state.selection);
  const start = blockIndex(state.doc, from.blockId);
  const end = blockIndex(state.doc, to.blockId);
  return state.doc.blocks.slice(start, end + 1).map((block) => {
    const a = block.id === from.blockId ? from.offset : 0;
    const b = block.id === to.blockId ? to.offset : Infinity;
    const content = sliceInline(block.content, a, b);
    return block.type === 'heading' ? heading(block.level, content) : paragraph(content);
  });
}
