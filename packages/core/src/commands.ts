// Editing commands. Each command is a pure function from state to state, so
// it can be unit tested without a DOM. The view maps browser input to these.
// A command returns the same state object when it does nothing.

import {
  type Block,
  type Cell,
  type EditorState,
  type HeadingLevel,
  type Inline,
  type ListItemBlock,
  type ListType,
  type Mark,
  type Position,
  type Selection,
  type TableBlock,
  type TextBlock,
  type Align,
  MAX_INDENT,
  blockIndex,
  caret,
  clampSelection,
  codeBlock,
  concatInline,
  containerContent,
  deleteInline,
  divider,
  emptyTable,
  endOf,
  formatAt,
  getBlock,
  heading,
  inlineLength,
  inlineText,
  insertInline,
  isCollapsed,
  isPlainTextBlock,
  isTextBlock,
  linkAt,
  listItem,
  orderedRange,
  paragraph,
  quote,
  rangeHasMark,
  sameMarks,
  setLinkInRange,
  setMarkInRange,
  setTokenInRange,
  sliceInline,
  sortMarks,
  startOf,
  toPlain,
  withContainerContent,
  withContent,
  createId,
} from './model';
import type { InlineSyntax } from './markdown/options';

export type Command = (state: EditorState) => EditorState;

function splice(state: EditorState, start: number, deleteCount: number, ...blocks: Block[]): Block[] {
  const next = state.doc.blocks.slice();
  next.splice(start, deleteCount, ...blocks);
  return next;
}

function withBlocks(state: EditorState, blocks: readonly Block[], selection: Selection = state.selection): EditorState {
  return { doc: { blocks }, selection, storedMarks: null };
}

function replaceBlock(state: EditorState, block: Block, selection?: Selection): EditorState {
  const index = blockIndex(state.doc, block.id);
  return withBlocks(state, splice(state, index, 1, block), selection);
}

/** A copy of a block with a new ID. */
export function cloneBlock(block: Block): Block {
  return { ...block, id: createId() };
}

function contentOf(block: Block, cell?: Cell): Inline {
  return containerContent(block, cell) ?? [];
}

/** The same kind of block, empty, for Enter and for paste splits. */
function emptyLike(block: TextBlock): TextBlock {
  switch (block.type) {
    case 'listItem':
      return listItem(block.listType, [], { indent: block.indent });
    case 'quote':
      return quote();
    default:
      return paragraph();
  }
}

// ---------------------------------------------------------------------------
// Deleting

/** Deletes everything between two positions (in document order) and joins the boundary blocks. */
export function deleteRange(state: EditorState, from: Position, to: Position): EditorState {
  const fromIndex = blockIndex(state.doc, from.blockId);
  const toIndex = blockIndex(state.doc, to.blockId);
  const fromBlock = state.doc.blocks[fromIndex]!;
  const toBlock = state.doc.blocks[toIndex]!;

  if (fromIndex === toIndex) {
    if (fromBlock.type === 'divider') return state;
    if (fromBlock.type === 'table') return deleteInTable(state, fromBlock, from, to);
    const content = deleteInline(fromBlock.content, from.offset, to.offset);
    return replaceBlock(state, withContent(fromBlock, content), caret(from.blockId, from.offset));
  }

  // Across blocks. Tables and dividers touched by the range are removed whole.
  const head = isTextBlock(fromBlock) ? withContent(fromBlock, sliceInline(fromBlock.content, 0, from.offset)) : null;
  const tail = isTextBlock(toBlock) ? sliceInline(toBlock.content, to.offset) : null;
  let replacement: Block[];
  let selection: Selection;
  if (head) {
    replacement = [tail ? withContent(head, concatInline(head.content, tail)) : head];
    selection = caret(head.id, from.offset);
  } else if (tail && isTextBlock(toBlock)) {
    replacement = [withContent(toBlock, tail)];
    selection = caret(toBlock.id, 0);
  } else {
    const p = paragraph();
    replacement = [p];
    selection = caret(p.id, 0);
  }
  return withBlocks(state, splice(state, fromIndex, toIndex - fromIndex + 1, ...replacement), selection);
}

/** Within one table: clears the text between two positions, across cells in reading order. */
function deleteInTable(state: EditorState, block: TableBlock, from: Position, to: Position): EditorState {
  const a = from.cell ?? { row: 0, col: 0 };
  const b = to.cell ?? { row: block.rows.length - 1, col: block.align.length - 1 };
  const cols = block.align.length;
  const ia = a.row * cols + a.col;
  const ib = b.row * cols + b.col;
  const rows = block.rows.map((row, r) =>
    row.map((cell, c) => {
      const i = r * cols + c;
      if (i < ia || i > ib) return cell;
      const start = i === ia ? from.offset : 0;
      const end = i === ib ? to.offset : inlineLength(cell);
      return deleteInline(cell, start, end);
    }),
  );
  return replaceBlock(state, { ...block, rows }, caret(block.id, from.offset, a));
}

export function deleteSelection(state: EditorState): EditorState {
  if (isCollapsed(state.selection)) return state;
  const { from, to } = orderedRange(state.doc, state.selection);
  return deleteRange(state, from, to);
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
  const pos = state.selection.focus;
  const index = blockIndex(state.doc, pos.blockId);
  const block = state.doc.blocks[index]!;

  if (block.type === 'divider') return removeBlockAt(state, index, -1);

  if (pos.offset > 0) {
    const text = inlineText(contentOf(block, pos.cell));
    const from = previousGrapheme(text, pos.offset);
    return deleteRange(state, { ...pos, offset: from }, pos);
  }

  if (block.type === 'table') {
    // At the start of a cell, move to the end of the previous cell.
    const cell = pos.cell!;
    const prevCell = cell.col > 0 ? { row: cell.row, col: cell.col - 1 } : cell.row > 0 ? { row: cell.row - 1, col: block.align.length - 1 } : null;
    if (!prevCell) return state;
    return { ...state, selection: caret(block.id, inlineLength(contentOf(block, prevCell)), prevCell) };
  }

  // At the start of a styled block, the first Backspace removes the style.
  if (block.type === 'listItem' && block.indent > 0) return replaceBlock(state, { ...block, indent: block.indent - 1 });
  if (block.type !== 'paragraph') return replaceBlock(state, paragraph(block.content, block.id));

  const prev = state.doc.blocks[index - 1];
  if (!prev) return state;
  if (prev.type === 'divider') return withBlocks(state, splice(state, index - 1, 1));
  if (prev.type === 'table') {
    // Backspace moves into the table; an empty block is removed on the way.
    const end = endOf(prev);
    const selection = { anchor: end, focus: end };
    return inlineLength(block.content) === 0 ? withBlocks(state, splice(state, index, 1), selection) : { ...state, selection };
  }
  return deleteRange(state, endOf(prev), { blockId: block.id, offset: 0 });
}

/** Delete (forward). */
export function deleteForward(state: EditorState): EditorState {
  if (!isCollapsed(state.selection)) return deleteSelection(state);
  const pos = state.selection.focus;
  const index = blockIndex(state.doc, pos.blockId);
  const block = state.doc.blocks[index]!;

  if (block.type === 'divider') return removeBlockAt(state, index, 1);
  const text = inlineText(contentOf(block, pos.cell));
  if (pos.offset < text.length) {
    return deleteRange(state, pos, { ...pos, offset: nextGrapheme(text, pos.offset) });
  }
  if (block.type === 'table') return state;

  const next = state.doc.blocks[index + 1];
  if (!next || next.type === 'table') return state;
  if (next.type === 'divider') return withBlocks(state, splice(state, index + 1, 1));
  return deleteRange(state, pos, { blockId: next.id, offset: 0 });
}

/** Removes the block at `index` and puts the caret at the end of the previous block (or the start of the next). */
function removeBlockAt(state: EditorState, index: number, prefer: -1 | 1): EditorState {
  const blocks = splice(state, index, 1);
  if (blocks.length === 0) {
    const p = paragraph();
    return withBlocks(state, [p], caret(p.id, 0));
  }
  const prev = blocks[index - 1];
  const next = blocks[index];
  const target = prefer === -1 ? (prev ?? next!) : (next ?? prev!);
  const pos = target === prev ? endOf(target) : startOf(target);
  return withBlocks(state, blocks, { anchor: pos, focus: pos });
}

// ---------------------------------------------------------------------------
// Typing

/** Inserts text at the selection with the current format. "\n" is a hard line break. */
export function insertText(state: EditorState, text: string): EditorState {
  const stored = state.storedMarks;
  const s = deleteSelection(state);
  const pos = s.selection.focus;
  const block = getBlock(s.doc, pos.blockId);
  const content = containerContent(block, pos.cell);
  if (content === null) return state;

  let value = text;
  if (block.type === 'table') value = value.replace(/\r?\n/g, ' ');
  const format = isPlainTextBlock(block) ? { marks: [] } : stored ? { marks: stored } : formatAt(content, pos.offset);
  const next = insertInline(content, pos.offset, value, format);
  return replaceBlock(s, withContainerContent(block, pos.cell, next), caret(block.id, pos.offset + value.length, pos.cell));
}

/**
 * ArrowDown on the last line of the last block, or ArrowUp on the first line
 * of the first block, when that block is a code block, table or divider: adds
 * an empty paragraph past it, so the caret is never stuck. In a table that is
 * the last (or first) row. Lines are lines of text; a wrapped line counts as
 * one.
 */
export function exitBlock(state: EditorState, dir: 1 | -1): EditorState {
  if (!isCollapsed(state.selection)) return state;
  const pos = state.selection.focus;
  const index = blockIndex(state.doc, pos.blockId);
  const block = state.doc.blocks[index]!;
  if (block.type !== 'code' && block.type !== 'table' && block.type !== 'divider') return state;
  if (index !== (dir === 1 ? state.doc.blocks.length - 1 : 0)) return state;

  if (block.type === 'table') {
    const row = pos.cell?.row ?? -1;
    if (row !== (dir === 1 ? block.rows.length - 1 : 0)) return state;
  } else if (block.type === 'code') {
    const text = inlineText(block.content);
    const rest = dir === 1 ? text.slice(pos.offset) : text.slice(0, pos.offset);
    if (rest.includes('\n')) return state;
  }

  const p = paragraph();
  return withBlocks(state, splice(state, dir === 1 ? index + 1 : 0, 0, p), caret(p.id, 0));
}

/** Shift+Enter: a hard line break. A newline in code; nothing in a table cell. */
export function insertLineBreak(state: EditorState): EditorState {
  const block = getBlock(state.doc, state.selection.focus.blockId);
  if (block.type === 'table' || block.type === 'divider') return state;
  return insertText(state, '\n');
}

/** Enter. */
export function splitBlock(state: EditorState): EditorState {
  const s = deleteSelection(state);
  const pos = s.selection.focus;
  const index = blockIndex(s.doc, pos.blockId);
  const block = s.doc.blocks[index]!;

  if (block.type === 'divider') {
    const p = paragraph();
    return withBlocks(s, splice(s, index + 1, 0, p), caret(p.id, 0));
  }
  if (block.type === 'table') return tableEnter(s, block, pos);

  const text = inlineText(block.content);
  const length = text.length;

  if (isPlainTextBlock(block)) {
    // Enter on an empty last line, below another empty line, leaves the code block.
    if (pos.offset === length && text.endsWith('\n\n')) {
      const trimmed = withContent(block, sliceInline(block.content, 0, length - 2));
      const p = paragraph();
      return withBlocks(s, splice(s, index, 1, trimmed, p), caret(p.id, 0));
    }
    return insertText(s, '\n');
  }

  // "```lang" + Enter in a paragraph starts a code block.
  const fence = block.type === 'paragraph' && pos.offset === length ? /^```([^`\s]*)$/.exec(text) : null;
  if (fence) {
    const code = codeBlock(fence[1], '', block.id);
    return replaceBlock(s, code, caret(code.id, 0));
  }

  // Enter in an empty list item or quote ends the list or quote.
  if (length === 0 && block.type === 'listItem') {
    const next = block.indent > 0 ? { ...block, indent: block.indent - 1 } : paragraph([], block.id);
    return replaceBlock(s, next);
  }
  if (length === 0 && block.type === 'quote') return replaceBlock(s, paragraph([], block.id));

  // Enter at the start of a non-empty block inserts an empty block above
  // and keeps the caret where it is.
  if (pos.offset === 0 && length > 0) {
    return withBlocks(s, splice(s, index, 0, emptyLike(block)), s.selection);
  }

  const left = withContent(block, sliceInline(block.content, 0, pos.offset));
  const rightContent = sliceInline(block.content, pos.offset);
  let right: TextBlock;
  if (block.type === 'heading') {
    // Splitting a heading in the middle gives two headings; at the end, a paragraph.
    right = rightContent.length > 0 ? heading(block.level, rightContent) : paragraph();
  } else {
    right = withContent(emptyLike(block), rightContent);
  }
  return withBlocks(s, splice(s, index, 1, left, right), caret(right.id, 0));
}

/** Enter in a table moves to the cell below, adding a row at the bottom. */
function tableEnter(state: EditorState, block: TableBlock, pos: Position): EditorState {
  const cell = pos.cell!;
  let table = block;
  if (cell.row === block.rows.length - 1) table = addRow(block, cell.row + 1);
  const below = { row: cell.row + 1, col: cell.col };
  return replaceBlock(state, table, caret(table.id, 0, below));
}

// ---------------------------------------------------------------------------
// Marks and links

/**
 * Calls `fn` for each text container in the range, with the offsets inside it,
 * and returns the document's blocks with the results. Code and HTML blocks are
 * skipped: marks and links do not apply there.
 */
function mapTextInRange(
  state: EditorState,
  from: Position,
  to: Position,
  fn: (content: Inline, a: number, b: number) => Inline,
): Block[] {
  const start = blockIndex(state.doc, from.blockId);
  const end = blockIndex(state.doc, to.blockId);
  const updated = state.doc.blocks.slice(start, end + 1).map((block) => {
    if (block.type === 'divider' || isPlainTextBlock(block)) return block;
    if (block.type === 'table') {
      const cols = block.align.length;
      const fromIdx = block.id === from.blockId && from.cell ? from.cell.row * cols + from.cell.col : 0;
      const toIdx = block.id === to.blockId && to.cell ? to.cell.row * cols + to.cell.col : Infinity;
      const rows = block.rows.map((row, r) =>
        row.map((cell, c) => {
          const i = r * cols + c;
          if (i < fromIdx || i > toIdx) return cell;
          const a = i === fromIdx && block.id === from.blockId ? from.offset : 0;
          const b = i === toIdx && block.id === to.blockId ? to.offset : inlineLength(cell);
          return a < b ? keepIfSame(cell, fn(cell, a, b)) : cell;
        }),
      );
      return rows.every((row, r) => row.every((cell, c) => cell === block.rows[r]![c])) ? block : { ...block, rows };
    }
    const a = block.id === from.blockId ? from.offset : 0;
    const b = block.id === to.blockId ? to.offset : inlineLength(block.content);
    if (a >= b) return block;
    const content = keepIfSame(block.content, fn(block.content, a, b));
    return content === block.content ? block : withContent(block, content);
  });
  return splice(state, start, updated.length, ...updated);
}

/** `before` if `after` has the same spans, so an edit that changed nothing keeps the block. */
function keepIfSame(before: Inline, after: Inline): Inline {
  if (before.length !== after.length) return after;
  for (let i = 0; i < before.length; i++) {
    const x = before[i]!;
    const y = after[i]!;
    if (x.text !== y.text || x.link !== y.link || x.token !== y.token || x.image !== y.image || !sameMarks(x.marks, y.marks)) return after;
  }
  return before;
}

/** True if every character of the selection carries the mark (or, collapsed, the next typed text will). */
export function isMarkActive(state: EditorState, mark: Mark): boolean {
  if (isCollapsed(state.selection)) {
    const pos = state.selection.focus;
    const block = getBlock(state.doc, pos.blockId);
    const marks = state.storedMarks ?? formatAt(contentOf(block, pos.cell), pos.offset).marks;
    return marks.includes(mark);
  }
  const { from, to } = orderedRange(state.doc, state.selection);
  const hasMark: boolean[] = [];
  mapTextInRange(state, from, to, (content, a, b) => {
    hasMark.push(rangeHasMark(content, a, b, mark));
    return content;
  });
  return hasMark.length > 0 && hasMark.every(Boolean);
}

export function toggleMark(state: EditorState, mark: Mark): EditorState {
  const { from, to } = orderedRange(state.doc, state.selection);
  if (isCollapsed(state.selection)) {
    const block = getBlock(state.doc, from.blockId);
    if (isPlainTextBlock(block)) return state;
    const current = state.storedMarks ?? formatAt(contentOf(block, from.cell), from.offset).marks;
    const next = current.includes(mark) ? current.filter((m) => m !== mark) : sortMarks([...current, mark]);
    return { ...state, storedMarks: next };
  }
  const on = !isMarkActive(state, mark);
  const blocks = mapTextInRange(state, from, to, (content, a, b) => setMarkInRange(content, a, b, mark, on));
  return { ...state, doc: { blocks }, storedMarks: null };
}

/** The link under the caret or at the start of the selection. */
export function activeLink(state: EditorState): { href: string; from: number; to: number; pos: Position } | null {
  const { from } = orderedRange(state.doc, state.selection);
  const block = getBlock(state.doc, from.blockId);
  const content = containerContent(block, from.cell);
  if (!content) return null;
  const link = linkAt(content, from.offset);
  return link ? { ...link, pos: from } : null;
}

/**
 * Sets a link on the selection, or removes it when `href` is null. With a
 * collapsed selection inside a link, changes the whole link.
 */
export function setLink(state: EditorState, href: string | null): EditorState {
  let from: Position;
  let to: Position;
  if (isCollapsed(state.selection)) {
    const link = activeLink(state);
    if (!link) return state;
    from = { ...link.pos, offset: link.from };
    to = { ...link.pos, offset: link.to };
  } else {
    ({ from, to } = orderedRange(state.doc, state.selection));
  }
  const blocks = mapTextInRange(state, from, to, (content, a, b) => setLinkInRange(content, a, b, href));
  return { ...state, doc: { blocks }, storedMarks: null };
}

// ---------------------------------------------------------------------------
// Block types

export type BlockTypeSpec =
  | { type: 'paragraph' }
  | { type: 'heading'; level: HeadingLevel }
  | { type: 'listItem'; listType: ListType }
  | { type: 'quote' }
  | { type: 'code'; language?: string }
  | { type: 'table'; rows?: number; cols?: number }
  | { type: 'divider' };

/** Converts one text block to another type, keeping its ID and text. */
function convert(block: TextBlock, spec: BlockTypeSpec): TextBlock {
  const content = block.content;
  switch (spec.type) {
    case 'paragraph':
      return paragraph(content, block.id);
    case 'heading':
      return heading(spec.level, content, block.id);
    case 'listItem':
      return listItem(spec.listType, content, {
        id: block.id,
        indent: block.type === 'listItem' ? block.indent : 0,
        checked: block.type === 'listItem' ? block.checked : false,
      });
    case 'quote':
      return quote(content, block.id);
    case 'code':
      return codeBlock(spec.language ?? (block.type === 'code' ? block.language : ''), inlineText(toPlain(content)), block.id);
    default:
      return block;
  }
}

/**
 * Changes the type of every text block touched by the selection. Text and IDs
 * are kept. Tables and dividers are inserted instead (see insertBlock).
 */
export function setBlockType(state: EditorState, spec: BlockTypeSpec): EditorState {
  if (spec.type === 'table' || spec.type === 'divider') return insertBlock(state, spec);
  const { from, to } = orderedRange(state.doc, state.selection);
  const start = blockIndex(state.doc, from.blockId);
  const end = blockIndex(state.doc, to.blockId);
  const updated = state.doc.blocks.slice(start, end + 1).map((b) => (isTextBlock(b) && b.type !== 'raw' ? convert(b, spec) : b));
  const doc = { blocks: splice(state, start, updated.length, ...updated) };
  return { doc, selection: clampSelection(doc, state.selection), storedMarks: null };
}

/** True if the block already has the type `spec` describes. */
function hasType(block: Block, spec: BlockTypeSpec): boolean {
  switch (spec.type) {
    case 'heading':
      return block.type === 'heading' && block.level === spec.level;
    case 'listItem':
      return block.type === 'listItem' && block.listType === spec.listType;
    case 'code':
      return block.type === 'code';
    default:
      return block.type === spec.type;
  }
}

/**
 * Sets the type of the selected text blocks, or turns them back into
 * paragraphs when they all have that type already.
 */
export function toggleBlockType(state: EditorState, spec: BlockTypeSpec): EditorState {
  const { from, to } = orderedRange(state.doc, state.selection);
  const blocks = state.doc.blocks.slice(blockIndex(state.doc, from.blockId), blockIndex(state.doc, to.blockId) + 1);
  const text = blocks.filter((b) => isTextBlock(b) && b.type !== 'raw');
  if (text.length === 0) return state;
  const on = text.every((b) => hasType(b, spec));
  return setBlockType(state, on ? { type: 'paragraph' } : spec);
}

/**
 * Applies a slash menu pick. Text types convert the current block in place.
 * A table or divider replaces the current block if it is empty and otherwise
 * goes below it. A divider is followed by a paragraph for the caret.
 */
export function insertBlock(state: EditorState, spec: BlockTypeSpec): EditorState {
  const pos = state.selection.focus;
  const index = blockIndex(state.doc, pos.blockId);
  const current = state.doc.blocks[index]!;
  if (spec.type !== 'table' && spec.type !== 'divider') return setBlockType(state, spec);
  const isEmpty = isTextBlock(current) && inlineLength(current.content) === 0;
  const created = spec.type === 'table' ? emptyTable(spec.rows ?? 3, spec.cols ?? 3) : divider();
  const blocks: Block[] = [created];
  let target: Block = created;
  if (created.type === 'divider') {
    const after = state.doc.blocks[index + 1];
    if (after && isTextBlock(after)) target = after;
    else {
      target = paragraph();
      blocks.push(target);
    }
  }
  const start = startOf(target);
  const at = isEmpty ? index : index + 1;
  return withBlocks(state, splice(state, at, isEmpty ? 1 : 0, ...blocks), { anchor: start, focus: start });
}

// ---------------------------------------------------------------------------
// Lists

/** Tab / Shift+Tab on list items: changes nesting by one level. */
export function indentListItems(state: EditorState, delta: 1 | -1): EditorState {
  const { from, to } = orderedRange(state.doc, state.selection);
  const start = blockIndex(state.doc, from.blockId);
  const end = blockIndex(state.doc, to.blockId);
  let changed = false;
  const blocks = state.doc.blocks.slice();
  for (let i = start; i <= end; i++) {
    const b = blocks[i]!;
    if (b.type !== 'listItem') continue;
    const prev = blocks[i - 1];
    // An item can be at most one level deeper than the item above it.
    const max = prev?.type === 'listItem' ? Math.min(MAX_INDENT, prev.indent + 1) : 0;
    const indent = Math.max(0, Math.min(max, b.indent + delta));
    if (indent !== b.indent) {
      blocks[i] = { ...b, indent };
      changed = true;
    }
  }
  return changed ? withBlocks(state, blocks) : state;
}

export function toggleTask(state: EditorState, blockId: string): EditorState {
  const block = getBlock(state.doc, blockId);
  if (block.type !== 'listItem' || block.listType !== 'task') return state;
  const next: ListItemBlock = { ...block, checked: !block.checked };
  return replaceBlock(state, next);
}

/** Sets a code block's language, from the input in its header. */
export function setCodeLanguage(state: EditorState, blockId: string, language: string): EditorState {
  const block = getBlock(state.doc, blockId);
  if (block.type !== 'code' || block.language === language) return state;
  return replaceBlock(state, { ...block, language });
}

// ---------------------------------------------------------------------------
// Block menu

export function duplicateBlock(state: EditorState, blockId: string): EditorState {
  const index = blockIndex(state.doc, blockId);
  const copy = cloneBlock(state.doc.blocks[index]!);
  const start = startOf(copy);
  return withBlocks(state, splice(state, index + 1, 0, copy), { anchor: start, focus: start });
}

export function deleteBlock(state: EditorState, blockId: string): EditorState {
  return removeBlockAt(state, blockIndex(state.doc, blockId), -1);
}

// ---------------------------------------------------------------------------
// Tables

export function addRow(block: TableBlock, at: number): TableBlock {
  const rows = block.rows.slice();
  rows.splice(Math.max(1, at), 0, block.align.map(() => []));
  return { ...block, rows };
}

export function addColumn(block: TableBlock, at: number): TableBlock {
  const align: Align[] = block.align.slice();
  align.splice(at, 0, null);
  const rows = block.rows.map((row) => {
    const r = row.slice();
    r.splice(at, 0, []);
    return r;
  });
  return { ...block, align, rows };
}

export type TableAction =
  | { kind: 'addRowAbove' }
  | { kind: 'addRowBelow' }
  | { kind: 'addColumnLeft' }
  | { kind: 'addColumnRight' }
  | { kind: 'deleteRow' }
  | { kind: 'deleteColumn' }
  | { kind: 'align'; align: Align };

/** Table edits relative to the cell with the caret. */
export function tableAction(state: EditorState, action: TableAction): EditorState {
  const pos = state.selection.focus;
  const block = getBlock(state.doc, pos.blockId);
  if (block.type !== 'table' || !pos.cell) return state;
  const { row, col } = pos.cell;
  let table: TableBlock = block;
  let cell: Cell = pos.cell;
  switch (action.kind) {
    case 'addRowAbove':
      // The header row stays first; adding above it adds below it instead.
      table = addRow(block, row === 0 ? 1 : row);
      cell = { row: row === 0 ? 1 : row, col };
      break;
    case 'addRowBelow':
      table = addRow(block, row + 1);
      cell = { row: row + 1, col };
      break;
    case 'addColumnLeft':
      table = addColumn(block, col);
      break;
    case 'addColumnRight':
      table = addColumn(block, col + 1);
      cell = { row, col: col + 1 };
      break;
    case 'deleteRow':
      if (block.rows.length <= 1) return deleteBlock(state, block.id);
      // Deleting the header promotes the next row.
      table = { ...block, rows: block.rows.filter((_, r) => r !== row) };
      cell = { row: Math.min(row, table.rows.length - 1), col };
      break;
    case 'deleteColumn': {
      if (block.align.length <= 1) return deleteBlock(state, block.id);
      table = {
        ...block,
        align: block.align.filter((_, c) => c !== col),
        rows: block.rows.map((r) => r.filter((_, c) => c !== col)),
      };
      cell = { row, col: Math.min(col, table.align.length - 1) };
      break;
    }
    case 'align':
      table = { ...block, align: block.align.map((a, c) => (c === col ? action.align : a)) };
      break;
  }
  const offset = Math.min(pos.offset, inlineLength(contentOf(table, cell)));
  return replaceBlock(state, table, caret(table.id, cell === pos.cell ? offset : 0, cell));
}

/** Tab / Shift+Tab in a table: next or previous cell. Tab in the last cell adds a row. */
export function moveCell(state: EditorState, delta: 1 | -1): EditorState {
  const pos = state.selection.focus;
  const block = getBlock(state.doc, pos.blockId);
  if (block.type !== 'table' || !pos.cell) return state;
  const cols = block.align.length;
  const index = pos.cell.row * cols + pos.cell.col + delta;
  if (index < 0) return state;
  let table = block;
  if (index >= block.rows.length * cols) table = addRow(block, block.rows.length);
  const cell = { row: Math.floor(index / cols), col: index % cols };
  const content = contentOf(table, cell);
  const selection: Selection = {
    anchor: { blockId: block.id, offset: 0, cell },
    focus: { blockId: block.id, offset: inlineLength(content), cell },
  };
  return table === block ? { ...state, selection } : withBlocks(state, splice(state, blockIndex(state.doc, block.id), 1, table), selection);
}

// ---------------------------------------------------------------------------
// Markdown shortcuts

/**
 * Block shortcuts typed at the start of a paragraph, e.g. "## " turns it into
 * a level 2 heading. Runs after a space or "-" is typed. Returns null when no
 * rule applies.
 */
export function applyBlockInputRules(state: EditorState): EditorState | null {
  if (!isCollapsed(state.selection)) return null;
  const pos = state.selection.focus;
  const block = getBlock(state.doc, pos.blockId);
  if (!isTextBlock(block) || pos.cell) return null;
  const before = inlineText(block.content).slice(0, pos.offset);

  if (block.type === 'paragraph' && before === '---') {
    const index = blockIndex(state.doc, block.id);
    const rest = withContent(block, sliceInline(block.content, pos.offset));
    return withBlocks(state, splice(state, index, 1, divider(), rest), caret(rest.id, 0));
  }

  const rules: [RegExp, (m: RegExpExecArray) => BlockTypeSpec][] = [
    [/^(#{1,6}) $/, (m) => ({ type: 'heading', level: m[1]!.length as HeadingLevel })],
    [/^[-*+] $/, () => ({ type: 'listItem', listType: 'bullet' })],
    [/^\d{1,9}[.)] $/, () => ({ type: 'listItem', listType: 'ordered' })],
    [/^\[[ xX]?\] $/, () => ({ type: 'listItem', listType: 'task' })],
    [/^> $/, () => ({ type: 'quote' })],
    [/^```([^`\s]*) $/, (m) => ({ type: 'code', language: m[1] })],
  ];
  // Only "[ ] " applies inside a bullet item (turning "- [ ] " into a task).
  const allowed = block.type === 'paragraph' || (block.type === 'listItem' && block.listType === 'bullet');
  if (!allowed) return null;
  for (const [re, toSpec] of rules) {
    const m = re.exec(before);
    if (!m) continue;
    const spec = toSpec(m);
    if (block.type === 'listItem' && !(spec.type === 'listItem' && spec.listType === 'task')) continue;
    const stripped = deleteRange(state, { blockId: block.id, offset: 0 }, pos);
    let next = setBlockType(stripped, spec);
    const converted = getBlock(next.doc, block.id);
    if (converted.type === 'listItem') {
      const start = /^(\d{1,9})/.exec(before);
      const checked = /^\[[xX]\]/.test(before);
      const updated: ListItemBlock = listItem(converted.listType, converted.content, {
        id: converted.id,
        indent: converted.indent,
        checked,
        start: converted.listType === 'ordered' && start ? Number(start[1]) : undefined,
      });
      next = replaceBlock(next, updated, next.selection);
    }
    return next;
  }
  return null;
}

const INLINE_RULES: { re: RegExp; mark: Mark; delim: number }[] = [
  { re: /(?:^|[^*])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, mark: 'bold', delim: 2 },
  { re: /(?:^|[^_\p{L}\p{N}])__([^_\s](?:[^_]*[^_\s])?)__$/u, mark: 'bold', delim: 2 },
  { re: /~~([^~\s](?:[^~]*[^~\s])?)~~$/, mark: 'strike', delim: 2 },
  { re: /(?:^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/, mark: 'italic', delim: 1 },
  { re: /(?:^|[^_\p{L}\p{N}])_([^_\s](?:[^_]*[^_\s])?)_$/u, mark: 'italic', delim: 1 },
  { re: /`([^`]+)`$/, mark: 'code', delim: 1 },
];

/**
 * Inline shortcuts: typing the closing delimiter of `**x**`, `*x*`, `_x_`,
 * `` `x` `` or `~~x~~` applies the mark and removes the delimiters.
 */
export function applyInlineInputRules(state: EditorState): EditorState | null {
  if (!isCollapsed(state.selection)) return null;
  const pos = state.selection.focus;
  const block = getBlock(state.doc, pos.blockId);
  if (isPlainTextBlock(block)) return null;
  const content = containerContent(block, pos.cell);
  if (!content) return null;
  const before = inlineText(content).slice(0, pos.offset);

  for (const rule of INLINE_RULES) {
    const m = rule.re.exec(before);
    if (!m) continue;
    const inner = m[1]!;
    const end = pos.offset;
    const innerEnd = end - rule.delim;
    const innerStart = innerEnd - inner.length;
    const start = innerStart - rule.delim;
    // The delimiters must be plain typed characters, not already formatted as code.
    if (rangeHasMark(content, start, end, 'code') || sliceInline(content, start, end).some((s) => s.image)) continue;
    let next = setMarkInRange(content, innerStart, innerEnd, rule.mark, true);
    next = deleteInline(next, innerEnd, end);
    next = deleteInline(next, start, innerStart);
    const offset = innerEnd - rule.delim;
    const updated = withContainerContent(block, pos.cell, next);
    const after = replaceBlock(state, updated, caret(block.id, offset, pos.cell));
    // Text typed next does not continue the new mark.
    const marks = formatAt(next, offset).marks.filter((m2) => m2 !== rule.mark);
    return { ...after, storedMarks: marks };
  }
  return null;
}

/**
 * Text just typed that completes a token of an inline syntax extension (for
 * example the closing `$` of `$x^2$`) becomes that token, so it is saved
 * verbatim instead of escaped. Only plain text on the caret's line counts.
 */
export function applyTokenInputRules(state: EditorState, syntax: readonly InlineSyntax[]): EditorState | null {
  if (syntax.length === 0 || !isCollapsed(state.selection)) return null;
  const pos = state.selection.focus;
  const block = getBlock(state.doc, pos.blockId);
  if (isPlainTextBlock(block)) return null;
  const content = containerContent(block, pos.cell);
  if (!content) return null;
  const text = inlineText(content);
  const end = pos.offset;
  const lineStart = Math.max(text.lastIndexOf('\n', end - 1) + 1, end - 1000);
  for (let start = end - 1; start >= lineStart; start--) {
    for (const s of syntax) {
      if (!s.triggers.includes(text[start]!) || s.match(text, start) !== end) continue;
      const plainRange = sliceInline(content, start, end).every(
        (span) => !span.token && !span.image && !span.marks.includes('code') && !span.marks.includes('html'),
      );
      if (!plainRange) continue;
      const updated = withContainerContent(block, pos.cell, setTokenInRange(content, start, end, s.name));
      return replaceBlock(state, updated, state.selection);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Clipboard

/** The selected content as standalone blocks with fresh IDs. A partly selected table is copied whole. */
export function selectedBlocks(state: EditorState): Block[] {
  const { from, to } = orderedRange(state.doc, state.selection);
  const start = blockIndex(state.doc, from.blockId);
  const end = blockIndex(state.doc, to.blockId);
  return state.doc.blocks.slice(start, end + 1).map((block) => {
    if (!isTextBlock(block)) {
      if (block.type === 'table' && start === end && from.cell && to.cell) {
        // Within one table: copy the selected text of a single cell as a paragraph.
        if (from.cell.row === to.cell.row && from.cell.col === to.cell.col) {
          return paragraph(sliceInline(contentOf(block, from.cell), from.offset, to.offset));
        }
      }
      return cloneBlock(block);
    }
    const a = block.id === from.blockId ? from.offset : 0;
    const b = block.id === to.blockId ? to.offset : Infinity;
    return { ...withContent(block, sliceInline(block.content, a, b)), id: createId() };
  });
}

/**
 * Pastes blocks at the selection. A single pasted text block merges into the
 * current block as inline content. With several blocks, the first joins the
 * text before the caret, the last joins the text after it, and the rest are
 * inserted in between.
 */
export function insertBlocks(state: EditorState, fragment: readonly Block[]): EditorState {
  if (fragment.length === 0) return deleteSelection(state);
  const s = deleteSelection(state);
  const pos = s.selection.focus;
  const index = blockIndex(s.doc, pos.blockId);
  const block = s.doc.blocks[index]!;

  // In a table cell, a code block or an HTML block, paste as text.
  if (!isTextBlock(block) || isPlainTextBlock(block)) {
    const only = fragment[0]!;
    if (block.type === 'table' && fragment.length === 1 && isTextBlock(only) && !isPlainTextBlock(only)) {
      // One formatted paragraph keeps its formatting inside a cell.
      const content = contentOf(block, pos.cell);
      const pasted = only.content.map((sp) => ({ ...sp, text: sp.text.replace(/\n/g, ' ') }));
      const merged = concatInline(sliceInline(content, 0, pos.offset), pasted, sliceInline(content, pos.offset));
      const offset = pos.offset + inlineLength(pasted);
      return replaceBlock(s, withContainerContent(block, pos.cell, merged), caret(block.id, offset, pos.cell));
    }
    const text = fragment
      .map((b) => (isTextBlock(b) ? inlineText(toPlain(b.content)) : ''))
      .filter(Boolean)
      .join('\n');
    return insertText(s, text);
  }

  const before = sliceInline(block.content, 0, pos.offset);
  const after = sliceInline(block.content, pos.offset);
  const first = fragment[0]!;

  if (fragment.length === 1 && isTextBlock(first) && !(isPlainTextBlock(first) && inlineLength(block.content) > 0)) {
    const target: TextBlock = inlineLength(block.content) === 0 ? ({ ...first, id: block.id } as TextBlock) : block;
    const content = concatInline(before, first.content, after);
    return replaceBlock(s, withContent(target, content), caret(block.id, pos.offset + inlineLength(first.content)));
  }

  const out: Block[] = [];
  let rest = fragment.slice();
  // The first pasted text block joins the text before the caret.
  if (before.length > 0) {
    if (isTextBlock(first) && !isPlainTextBlock(first)) {
      out.push(withContent(block, concatInline(before, first.content)));
      rest = rest.slice(1);
    } else {
      out.push(withContent(block, before));
    }
  } else if (isTextBlock(first)) {
    out.push({ ...first, id: block.id });
    rest = rest.slice(1);
  }
  out.push(...rest);

  // The text after the caret joins the last pasted text block.
  const last = out[out.length - 1]!;
  let caretPos: Position;
  if (isTextBlock(last) && !isPlainTextBlock(last)) {
    caretPos = { blockId: last.id, offset: inlineLength(last.content) };
    if (after.length > 0) out[out.length - 1] = withContent(last, concatInline(last.content, after));
  } else {
    const tail = withContent(emptyLike(block), after);
    out.push(tail);
    caretPos = { blockId: tail.id, offset: 0 };
  }
  return withBlocks(s, splice(s, index, 1, ...out), { anchor: caretPos, focus: caretPos });
}

// ---------------------------------------------------------------------------
// Selection

export function selectAll(state: EditorState): EditorState {
  const blocks = state.doc.blocks;
  const selection = { anchor: startOf(blocks[0]!), focus: endOf(blocks[blocks.length - 1]!) };
  return { ...state, selection, storedMarks: null };
}

// ---------------------------------------------------------------------------
// Inserting content

export interface InsertOptions {
  /**
   * Where to insert. `'selection'` (default) replaces the selection, like a
   * paste. `'end'` appends after the last block. A position inserts there
   * and replaces nothing.
   */
  readonly at?: 'selection' | 'end' | Position;
  /**
   * Insert as separate blocks even when the content is a single paragraph.
   * A text block at the target is split. Default false: a single text block
   * is inserted inline.
   */
  readonly block?: boolean;
  /** `'end'` (default) puts the caret after the inserted content; `'keep'` keeps the current selection. */
  readonly select?: 'end' | 'keep';
}

/** Inserts blocks, for example parsed Markdown. See InsertOptions. */
export function insertFragment(state: EditorState, fragment: readonly Block[], options: InsertOptions = {}): EditorState {
  if (fragment.length === 0) return state;
  const at = options.at ?? 'selection';
  let s = state;
  let target: Position;
  if (at === 'selection') {
    s = deleteSelection(state);
    target = s.selection.focus;
  } else if (at === 'end') {
    const last = state.doc.blocks[state.doc.blocks.length - 1]!;
    target = endOf(last);
  } else {
    target = clampSelection(state.doc, { anchor: at, focus: at }).focus;
  }

  let next: EditorState;
  /** Where text that was after the target ends up. */
  let after: Position;
  if (options.block || at === 'end') {
    ({ state: next, after } = insertAsBlocks(s, fragment, target));
  } else {
    next = insertBlocks({ ...s, selection: { anchor: target, focus: target } }, fragment);
    after = next.selection.focus;
  }
  if (options.select !== 'keep') return next;
  const map = (p: Position): Position =>
    p.blockId === target.blockId && sameCellOf(p.cell, target.cell) && p.offset > target.offset
      ? { ...after, offset: after.offset + p.offset - target.offset }
      : p;
  const selection = clampSelection(next.doc, { anchor: map(s.selection.anchor), focus: map(s.selection.focus) });
  return { ...next, selection };
}

function sameCellOf(a?: Cell, b?: Cell): boolean {
  return a?.row === b?.row && a?.col === b?.col;
}

/**
 * Inserts blocks before or after the block at `target`, splitting a text
 * block when the target is inside it. An empty paragraph is replaced.
 */
function insertAsBlocks(state: EditorState, fragment: readonly Block[], target: Position): { state: EditorState; after: Position } {
  const index = blockIndex(state.doc, target.blockId);
  const block = state.doc.blocks[index]!;
  const end = (blocks: readonly Block[], last: Block, after: Position) => {
    const pos = endOf(last);
    return { state: withBlocks(state, blocks, { anchor: pos, focus: pos }), after };
  };
  const last = fragment[fragment.length - 1]!;
  if (block.type === 'paragraph' && inlineLength(block.content) === 0) {
    return end(splice(state, index, 1, ...fragment), last, endOf(last));
  }
  if (!isTextBlock(block) || isPlainTextBlock(block) || target.offset >= inlineLength(block.content)) {
    return end(splice(state, index + 1, 0, ...fragment), last, target);
  }
  if (target.offset === 0) return end(splice(state, index, 0, ...fragment), last, startOf(block));
  const head = withContent(block, sliceInline(block.content, 0, target.offset));
  let tail: TextBlock = { ...withContent(block, sliceInline(block.content, target.offset)), id: createId() };
  if (tail.type === 'listItem' && tail.start !== undefined) tail = { ...tail, start: undefined };
  return end(splice(state, index, 1, head, ...fragment, tail), last, startOf(tail));
}
