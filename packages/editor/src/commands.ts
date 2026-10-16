// Editing commands. Each command is a pure function from state to state, so
// it can be unit tested without a DOM. The view maps browser input to these.
// A command returns the same state object when it does nothing.

import {
  type Block,
  CALLOUT_TYPES,
  type CalloutType,
  type Cell,
  type DetailsBlock,
  type EditorState,
  type HeadingLevel,
  type ImageAlign,
  type ImageAtom,
  type Inline,
  type ListItemBlock,
  type ListType,
  type Mark,
  type Position,
  type Selection,
  type TableBlock,
  type RawBlock,
  type TextBlock,
  type Align,
  ATOM_CHAR,
  MAX_INDENT,
  blockIndex,
  caret,
  clampSelection,
  codeBlock,
  concatInline,
  containerContent,
  deleteInline,
  details,
  detailsEnd,
  divider,
  emptyTable,
  endOf,
  formatAt,
  getBlock,
  heading,
  imageBlockOffset,
  inlineLength,
  inlineText,
  insertInline,
  isCollapsed,
  isPlainTextBlock,
  isTextBlock,
  isTextless,
  linkAt,
  listItem,
  orderedRange,
  paragraph,
  plain,
  quote,
  quoteKind,
  rangeHasMark,
  sameQuote,
  sameCell,
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
  withQuote,
  createId,
  sameLink,
  keepQuoteStart,
} from './model';
import { emailLiterals, isLiteralBoundary, urlLiteralAt } from './markdown/autolink';
import type { InlineSyntax } from './markdown/options';
import { isExcluded } from './decorations';

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
      return listItem(block.listType, [], { indent: block.indent, quote: quoteKind(block) });
    case 'quote':
      return quote([], undefined, block.callout);
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
    if (isTextless(fromBlock)) return state;
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
  if (!isCollapsed(state.selection)) {
    // A selected image block goes as a whole block, not as an image that leaves an empty paragraph.
    const image = selectedImageBlock(state);
    return image ? removeBlockAt(state, blockIndex(state.doc, image.pos.blockId), -1) : deleteSelection(state);
  }
  const pos = state.selection.focus;
  const index = blockIndex(state.doc, pos.blockId);
  const block = state.doc.blocks[index]!;

  if (isTextless(block)) return removeBlockAt(state, index, -1);

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
  // A list item in a quote becomes a paragraph of the quote first.
  if (block.type === 'listItem' && block.indent > 0) return replaceBlock(state, { ...block, indent: block.indent - 1 });
  if (block.type === 'listItem' && block.quote) return replaceBlock(state, keepQuoteStart(block, quote(block.content, block.id, block.callout)));
  if (block.type !== 'paragraph') return replaceBlock(state, paragraph(block.content, block.id));

  const prev = state.doc.blocks[index - 1];
  if (!prev) return state;
  if (prev.type === 'detailsEnd') {
    // Backspace after a collapsible section moves into its last line; an empty block is removed on the way.
    const end = lastTextBefore(state.doc.blocks, index);
    if (!end) return state;
    const selection = { anchor: end, focus: end };
    return inlineLength(block.content) === 0 ? withBlocks(state, splice(state, index, 1), selection) : { ...state, selection, storedMarks: null };
  }
  if (prev.type === 'divider') return withBlocks(state, splice(state, index - 1, 1));
  const prevImage = imageBlockOffset(prev);
  if (prevImage !== null) {
    // Select the image block above first, so a second Backspace deletes it; an empty paragraph is removed on the way.
    const selection = imageSelection(prev.id, prevImage);
    return inlineLength(block.content) === 0 ? withBlocks(state, splice(state, index, 1), selection) : { ...state, selection, storedMarks: null };
  }
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
  if (!isCollapsed(state.selection)) {
    const image = selectedImageBlock(state);
    return image ? removeBlockAt(state, blockIndex(state.doc, image.pos.blockId), 1) : deleteSelection(state);
  }
  const pos = state.selection.focus;
  const index = blockIndex(state.doc, pos.blockId);
  const block = state.doc.blocks[index]!;

  if (isTextless(block)) return removeBlockAt(state, index, 1);
  const text = inlineText(contentOf(block, pos.cell));
  if (pos.offset < text.length) {
    return deleteRange(state, pos, { ...pos, offset: nextGrapheme(text, pos.offset) });
  }
  if (block.type === 'table') return state;

  const next = state.doc.blocks[index + 1];
  if (!next || next.type === 'table' || next.type === 'detailsEnd') return state;
  if (next.type === 'details') {
    // Delete before a collapsible section removes an empty line, and never pulls the section's title in.
    return inlineLength(contentOf(block)) === 0 ? removeBlockAt(state, index, 1) : state;
  }
  if (next.type === 'divider') return withBlocks(state, splice(state, index + 1, 1));
  const nextImage = imageBlockOffset(next);
  if (nextImage !== null) {
    // Select the image block below rather than pulling it into this block; an empty paragraph is removed on the way.
    const selection = imageSelection(next.id, nextImage);
    return block.type === 'paragraph' && inlineLength(block.content) === 0
      ? withBlocks(state, splice(state, index, 1), selection)
      : { ...state, selection, storedMarks: null };
  }
  return deleteRange(state, pos, { blockId: next.id, offset: 0 });
}

/** Removes the block at `index` and puts the caret at the end of the previous block (or the start of the next). */
/** The end of the nearest block before `index` that holds text or cells: the last line of a collapsible section above. */
function lastTextBefore(blocks: readonly Block[], index: number): Position | null {
  for (let i = index - 1; i >= 0; i--) if (!isTextless(blocks[i]!)) return endOf(blocks[i]!);
  return null;
}

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
  // A table cell and a section title are one line.
  if (block.type === 'table' || block.type === 'details') value = value.replace(/\r?\n/g, ' ');
  const format = isPlainTextBlock(block) ? { marks: [] } : stored ? { marks: stored } : formatAt(content, pos.offset);
  const next = insertInline(content, pos.offset, value, format);
  return replaceBlock(s, withContainerContent(block, pos.cell, next), caret(block.id, pos.offset + value.length, pos.cell));
}

/**
 * ArrowDown on the last line of the last block, or ArrowUp on the first line
 * of the first block, when that block is a code block, table or divider, or
 * a selected image block: adds an empty paragraph past it, so the caret is
 * never stuck. In a table that is the last (or first) row. Lines are lines of
 * text; a wrapped line counts as one.
 */
export function exitBlock(state: EditorState, dir: 1 | -1): EditorState {
  const image = selectedImageBlock(state);
  if (!isCollapsed(state.selection) && !image) return state;
  const pos = image?.pos ?? state.selection.focus;
  const index = blockIndex(state.doc, pos.blockId);
  const block = state.doc.blocks[index]!;
  if (block.type !== 'code' && block.type !== 'table' && block.type !== 'divider' && !image) return state;
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

/** Adds an empty paragraph at the end of the document, with the caret in it. */
export function appendParagraph(state: EditorState): EditorState {
  const p = paragraph();
  return withBlocks(state, [...state.doc.blocks, p], caret(p.id, 0));
}

/** Shift+Enter: a hard line break. A newline in code; nothing in a table cell. */
export function insertLineBreak(state: EditorState): EditorState {
  const block = getBlock(state.doc, state.selection.focus.blockId);
  if (block.type === 'table' || isTextless(block) || block.type === 'details') return state;
  return insertText(state, '\n');
}

/** Enter. */
export function splitBlock(state: EditorState): EditorState {
  const s = deleteSelection(state);
  const pos = s.selection.focus;
  const index = blockIndex(s.doc, pos.blockId);
  const block = s.doc.blocks[index]!;

  if (isTextless(block)) {
    const p = paragraph();
    return withBlocks(s, splice(s, index + 1, 0, p), caret(p.id, 0));
  }
  if (block.type === 'table') return tableEnter(s, block, pos);
  if (block.type === 'details') return detailsEnter(s, block, index, pos.offset);

  const text = inlineText(block.content);
  const length = text.length;

  if (isPlainTextBlock(block)) {
    // Enter on an empty last line, below another empty line, leaves the code or raw block.
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

  // Enter in an empty list item or quote ends the list or quote. A list in a
  // quote ends with an empty paragraph of the quote.
  if (length === 0 && block.type === 'listItem') {
    const next =
      block.indent > 0
        ? { ...block, indent: block.indent - 1 }
        : block.quote
          ? keepQuoteStart(block, quote([], block.id, block.callout))
          : paragraph([], block.id);
    return replaceBlock(s, next);
  }
  if (length === 0 && block.type === 'quote') return replaceBlock(s, paragraph([], block.id));
  // Enter on an empty last line of a collapsible section moves the line out, after the section.
  if (length === 0 && block.type === 'paragraph' && s.doc.blocks[index + 1]?.type === 'detailsEnd') {
    const blocks = s.doc.blocks.slice();
    blocks.splice(index, 1);
    blocks.splice(index + 1, 0, block);
    return withBlocks(s, blocks, s.selection);
  }

  // Enter at the start of a non-empty block inserts an empty block above
  // and keeps the caret where it is. The empty block starts the blockquote if this one did.
  if (pos.offset === 0 && length > 0) {
    if (block.type !== 'heading' && block.type !== 'paragraph' && block.quoteStart) {
      const { quoteStart: _start, ...rest } = block;
      return withBlocks(s, splice(s, index, 1, keepQuoteStart(block, emptyLike(block)), rest as TextBlock), s.selection);
    }
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

/**
 * Enter in a section title. At the start of a title with text, an empty line
 * goes above the section. At its end, an empty first line of the body takes
 * the caret. Otherwise the text after the caret starts the body, or goes
 * after the section when it is collapsed (`collapsed`).
 */
function detailsEnter(state: EditorState, block: DetailsBlock, index: number, offset: number, collapsed = false): EditorState {
  const length = inlineLength(block.content);
  if (offset === 0 && length > 0) return withBlocks(state, splice(state, index, 0, paragraph()), state.selection);
  // At the end of the title, an empty first line of the body takes the caret.
  const first = state.doc.blocks[index + 1];
  if (!collapsed && offset === length && first?.type === 'paragraph' && inlineLength(first.content) === 0) {
    return { ...state, selection: caret(first.id, 0), storedMarks: null };
  }
  const left = withContent(block, sliceInline(block.content, 0, offset));
  const right = paragraph(sliceInline(block.content, offset));
  const blocks = state.doc.blocks.slice();
  blocks[index] = left;
  blocks.splice(collapsed ? (sectionEnd(blocks, index) ?? index) + 1 : index + 1, 0, right);
  return withBlocks(state, blocks, caret(right.id, 0));
}

/** Enter in the title of a collapsed section: the new line goes after the section. */
export function splitCollapsedTitle(state: EditorState): EditorState {
  const s = deleteSelection(state);
  const pos = s.selection.focus;
  const index = blockIndex(s.doc, pos.blockId);
  const block = s.doc.blocks[index]!;
  return block.type === 'details' ? detailsEnter(s, block, index, pos.offset, true) : splitBlock(state);
}

/** The index of the `detailsEnd` that closes the section titled at `index`, or null. */
export function sectionEnd(blocks: readonly Block[], index: number): number | null {
  let depth = 0;
  for (let i = index; i < blocks.length; i++) {
    const type = blocks[i]!.type;
    if (type === 'details') depth++;
    else if (type === 'detailsEnd' && --depth === 0) return i;
  }
  return null;
}

/** The index of the title of the section that the `detailsEnd` at `index` closes, or null. */
export function sectionTitle(blocks: readonly Block[], index: number): number | null {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    const type = blocks[i]!.type;
    if (type === 'detailsEnd') depth++;
    else if (type === 'details' && --depth === 0) return i;
  }
  return null;
}

/**
 * Blocks with every collapsible section whole: an end with no open section
 * is dropped, and a title whose end is missing becomes a paragraph. Returns
 * `blocks` itself when they already are.
 */
export function closeSections(blocks: readonly Block[]): readonly Block[] {
  if (!blocks.some((b) => b.type === 'details' || b.type === 'detailsEnd')) return blocks;
  const open: number[] = [];
  const drop = new Set<number>();
  blocks.forEach((b, i) => {
    if (b.type === 'details') open.push(i);
    else if (b.type === 'detailsEnd' && open.pop() === undefined) drop.add(i);
  });
  if (drop.size === 0 && open.length === 0) return blocks;
  const unclosed = new Set(open);
  const out: Block[] = [];
  blocks.forEach((b, i) => {
    if (drop.has(i)) return;
    out.push(unclosed.has(i) && b.type === 'details' ? paragraph(b.content, b.id) : b);
  });
  return out.length > 0 ? out : [paragraph()];
}

/**
 * Keeps collapsible sections whole after an edit (see `closeSections`), so
 * removing a title or an end unwraps its section. A caret on an end moves to
 * the end of the text before it.
 */
export function balanceSections(state: EditorState): EditorState {
  if (!state.doc.blocks.some((b) => b.type === 'details' || b.type === 'detailsEnd')) return state;
  const blocks = closeSections(state.doc.blocks);
  let next = state;
  if (blocks !== state.doc.blocks) {
    const doc = { blocks };
    next = { ...state, doc, selection: clampSelection(doc, state.selection) };
  }
  const onEnd = (p: Position) => next.doc.blocks.find((b) => b.id === p.blockId)?.type === 'detailsEnd';
  const { anchor, focus } = next.selection;
  if (!onEnd(anchor) && !onEnd(focus)) return next;
  const move = (p: Position) => (onEnd(p) ? (lastTextBefore(next.doc.blocks, blockIndex(next.doc, p.blockId)) ?? p) : p);
  return { ...next, selection: { anchor: move(anchor), focus: move(focus) } };
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
 * and returns the document's blocks with the results. Code and raw blocks are
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
    if (isTextless(block) || isPlainTextBlock(block)) return block;
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
    if (x.text !== y.text || !sameLink(x, y) || x.token !== y.token || x.image !== y.image || !sameMarks(x.marks, y.marks)) return after;
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
// Images

/** The image the selection covers exactly, with the position before it. Null when the selection is anything else. */
export function selectedImage(state: EditorState): { pos: Position; image: ImageAtom } | null {
  const { anchor, focus } = state.selection;
  if (anchor.blockId !== focus.blockId || !sameCell(anchor.cell, focus.cell)) return null;
  if (Math.abs(anchor.offset - focus.offset) !== 1) return null;
  const from = Math.min(anchor.offset, focus.offset);
  const content = containerContent(getBlock(state.doc, anchor.blockId), anchor.cell);
  const image = content ? sliceInline(content, from, from + 1)[0]?.image : undefined;
  return image ? { pos: { ...anchor, offset: from }, image } : null;
}

/** A selection of the image in an image block, whose image is at `offset`. */
function imageSelection(blockId: string, offset: number): Selection {
  return { anchor: { blockId, offset }, focus: { blockId, offset: offset + 1 } };
}

/** The selected image when it is an image block's (see `isImageBlock`), else null. */
export function selectedImageBlock(state: EditorState): { pos: Position; image: ImageAtom } | null {
  const selected = selectedImage(state);
  if (!selected || selected.pos.cell) return null;
  return imageBlockOffset(getBlock(state.doc, selected.pos.blockId)) === selected.pos.offset ? selected : null;
}

/** Selects the image after `pos` as one unit. */
export function selectImage(state: EditorState, pos: Position): EditorState {
  const block = state.doc.blocks.find((b) => b.id === pos.blockId);
  const content = block && containerContent(block, pos.cell);
  if (!content || !sliceInline(content, pos.offset, pos.offset + 1)[0]?.image) return state;
  return { ...state, selection: { anchor: pos, focus: { ...pos, offset: pos.offset + 1 } }, storedMarks: null };
}

/**
 * What `updateImage` changes. `null` removes a title, an alignment or a size;
 * a new width drops the height, so the image keeps its aspect ratio.
 */
export interface ImageChange {
  readonly alt?: string;
  readonly title?: string | null;
  /** Shown on image blocks only (see `isImageBlock`). */
  readonly align?: ImageAlign | null;
  readonly width?: number | null;
}

/** Changes the image after `pos` and selects it. */
export function updateImage(state: EditorState, pos: Position, change: ImageChange): EditorState {
  const block = state.doc.blocks.find((b) => b.id === pos.blockId);
  const content = block && containerContent(block, pos.cell);
  const span = content ? sliceInline(content, pos.offset, pos.offset + 1)[0] : undefined;
  if (!block || !content || !span?.image) return state;
  const { title: _title, align: _align, width: _width, height: _height, ...rest } = span.image;
  let title = span.image.title;
  if (change.title !== undefined) title = change.title || undefined;
  const align = change.align !== undefined ? (change.align ?? undefined) : span.image.align;
  let width = span.image.width;
  let height = span.image.height;
  if (change.width !== undefined) {
    width = change.width === null ? undefined : Math.max(1, Math.min(99999, Math.round(change.width)));
    if (width !== span.image.width) height = undefined;
  }
  const image: ImageAtom = {
    ...rest,
    ...(change.alt !== undefined ? { alt: change.alt } : {}),
    ...(title ? { title } : {}),
    ...(align ? { align } : {}),
    ...(width ? { width } : {}),
    ...(width && height ? { height } : {}),
  };
  const selected = selectImage(state, pos).selection;
  const same =
    image.alt === span.image.alt &&
    image.title === span.image.title &&
    image.align === span.image.align &&
    image.width === span.image.width &&
    image.height === span.image.height;
  if (same) return selected === state.selection ? state : { ...state, selection: selected, storedMarks: null };
  const next = concatInline(sliceInline(content, 0, pos.offset), [{ ...span, text: ATOM_CHAR, image }], sliceInline(content, pos.offset + 1));
  return replaceBlock(state, withContainerContent(block, pos.cell, next), selected);
}

// ---------------------------------------------------------------------------
// Block types

export type BlockTypeSpec =
  | { type: 'paragraph' }
  | { type: 'heading'; level: HeadingLevel }
  | { type: 'listItem'; listType: ListType }
  /** A quote, or with `callout` a callout of that type. */
  | { type: 'quote'; callout?: CalloutType }
  | { type: 'code'; language?: string }
  | { type: 'table'; rows?: number; cols?: number }
  | { type: 'divider' }
  /** A collapsible section: the block becomes its title, and an empty line its body. */
  | { type: 'details' };

/**
 * Converts one text block to another type, keeping its ID and text. A list
 * item made from a quote, or from a list item in a quote, stays in the quote.
 * A list item made a quote or callout keeps its list and goes into the quote.
 */
function convert(block: TextBlock, spec: BlockTypeSpec): TextBlock {
  return keepQuoteStart(block, convertType(block, spec));
}

function convertType(block: TextBlock, spec: BlockTypeSpec): TextBlock {
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
        start: block.type === 'listItem' && block.listType === spec.listType ? block.start : undefined,
        quote: quoteKind(block),
      });
    case 'quote':
      if (block.type === 'listItem') return withQuote(block, spec.callout ?? (block.quote ? (block.callout ?? 'quote') : 'quote'));
      return quote(content, block.id, spec.callout);
    case 'code':
      return codeBlock(spec.language ?? (block.type === 'code' ? block.language : ''), inlineText(toPlain(content)), block.id);
    default:
      return block;
  }
}

/** Text blocks whose type the block type commands change: all but raw source blocks. */
function isConvertible(block: Block): block is Exclude<TextBlock, RawBlock> {
  return isTextBlock(block) && block.type !== 'raw';
}

/**
 * Changes the type of every text block touched by the selection. Text and IDs
 * are kept. Tables and dividers are inserted instead (see insertBlock). Code
 * is the exception: adjacent blocks become one code block, a line per block.
 */
export function setBlockType(state: EditorState, spec: BlockTypeSpec): EditorState {
  if (spec.type === 'table' || spec.type === 'divider' || spec.type === 'details') return insertBlock(state, spec);
  return convertSelected(state, spec, (b) => convert(b, spec));
}

function convertSelected(
  state: EditorState,
  spec: BlockTypeSpec,
  convertBlock: (block: Exclude<TextBlock, RawBlock>) => TextBlock,
): EditorState {
  const { from, to } = orderedRange(state.doc, state.selection);
  const start = blockIndex(state.doc, from.blockId);
  const end = blockIndex(state.doc, to.blockId);
  const range = state.doc.blocks.slice(start, end + 1);
  if (spec.type === 'code' && range.filter(isConvertible).length > 1) return mergeIntoCode(state, start, range, spec.language);
  const updated = range.map((b) => (isConvertible(b) ? convertBlock(b) : b));
  const doc = { blocks: splice(state, start, updated.length, ...updated) };
  return { doc, selection: clampSelection(doc, state.selection), storedMarks: null };
}

/**
 * Turns each run of adjacent text blocks in `range` into one code block that
 * keeps the first block's ID, and selects the code. Formatting is dropped.
 */
function mergeIntoCode(state: EditorState, start: number, range: readonly Block[], language: string | undefined): EditorState {
  const out: Block[] = [];
  const merged: Block[] = [];
  let run: Exclude<TextBlock, RawBlock>[] = [];
  const flush = () => {
    const first = run[0];
    if (!first) return;
    const text = run.map((b) => inlineText(toPlain(b.content))).join('\n');
    const code = codeBlock(language ?? (first.type === 'code' ? first.language : ''), text, first.id);
    out.push(code);
    merged.push(code);
    run = [];
  };
  for (const block of range) {
    if (isConvertible(block)) run.push(block);
    else {
      flush();
      out.push(block);
    }
  }
  flush();
  const selection = { anchor: startOf(merged[0]!), focus: endOf(merged[merged.length - 1]!) };
  return { doc: { blocks: splice(state, start, range.length, ...out) }, selection, storedMarks: null };
}

/**
 * The blocks that form one blockquote with the block `blockId`: its
 * neighbours in the same quote or callout. Null when the block is not in a quote.
 */
export function quoteRun(state: EditorState, blockId: string): { start: number; end: number } | null {
  const blocks = state.doc.blocks;
  const index = blockIndex(state.doc, blockId);
  const block = blocks[index];
  if (quoteKind(block) === null) return null;
  let start = index;
  let end = index;
  while (sameQuote(blocks[start - 1], blocks[start])) start--;
  while (sameQuote(blocks[end], blocks[end + 1])) end++;
  return { start, end };
}

/** Sets the callout of the whole blockquote with the block `blockId`; null makes it a plain quote. */
export function setCallout(state: EditorState, blockId: string, callout: CalloutType | null): EditorState {
  const run = quoteRun(state, blockId);
  if (!run) return state;
  const blocks = state.doc.blocks.slice(run.start, run.end + 1);
  if (blocks.every((b) => quoteKind(b) === (callout ?? 'quote'))) return state;
  const updated = blocks.map((b) =>
    b.type === 'listItem' ? withQuote(b, callout ?? 'quote') : b.type === 'quote' ? keepQuoteStart(b, quote(b.content, b.id, callout ?? undefined)) : b,
  );
  const doc = { blocks: splice(state, run.start, updated.length, ...updated) };
  return { doc, selection: state.selection, storedMarks: state.storedMarks };
}

/** The blocks the selection touches whose type the block type commands change. */
export function convertibleBlocks(state: EditorState): Exclude<TextBlock, RawBlock>[] {
  const { from, to } = orderedRange(state.doc, state.selection);
  return state.doc.blocks.slice(blockIndex(state.doc, from.blockId), blockIndex(state.doc, to.blockId) + 1).filter(isConvertible);
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
    case 'quote': {
      // Any quote is a quote, a list item in one too; a callout must be of the same type.
      const kind = quoteKind(block);
      return kind !== null && (!spec.callout || kind === spec.callout);
    }
    default:
      return block.type === spec.type;
  }
}

/**
 * Sets the type of the selected text blocks, or turns them back into
 * paragraphs when they all have that type already.
 */
export function toggleBlockType(state: EditorState, spec: BlockTypeSpec): EditorState {
  const text = convertibleBlocks(state);
  if (text.length === 0) return state;
  const on = text.every((b) => hasType(b, spec));
  if (!on) return setBlockType(state, spec);
  // Off: a quoted list item leaves the quote and stays a list item, and a
  // list item in a quote becomes a paragraph of the quote.
  const off: BlockTypeSpec = { type: 'paragraph' };
  return convertSelected(state, off, (b) => {
    if (b.type === 'listItem' && spec.type === 'quote') return withQuote(b, null);
    if (b.type === 'listItem' && b.quote && spec.type === 'listItem') return keepQuoteStart(b, quote(b.content, b.id, b.callout));
    return convert(b, off);
  });
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
  if (spec.type === 'details') return insertSection(state, index);
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

/**
 * A collapsible section from the block at `index`: a text block becomes its
 * title, keeping its text as plain text, with an empty line as its body.
 * Another block gets a new section after it. The caret goes to the title
 * when it is empty, else to the body.
 */
function insertSection(state: EditorState, index: number): EditorState {
  const current = state.doc.blocks[index]!;
  const convert = isConvertible(current) && current.type !== 'details';
  const title = details(convert ? current.content : [], convert ? { id: current.id } : {});
  const body = paragraph();
  const at = convert ? index : index + 1;
  const blocks = splice(state, at, convert ? 1 : 0, title, body, detailsEnd());
  const target = inlineLength(title.content) === 0 ? caret(title.id, 0) : caret(body.id, 0);
  return withBlocks(state, blocks, target);
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
    // An item can be at most one level deeper than the item above it.
    const max = maxIndent(blocks[i - 1], b);
    const indent = Math.max(0, Math.min(max, b.indent + delta));
    if (indent !== b.indent) {
      blocks[i] = { ...b, indent };
      changed = true;
    }
  }
  return changed ? withBlocks(state, blocks) : state;
}

const CODE_INDENT = '  ';

/**
 * Tab / Shift+Tab in a code block. Tab at a caret inserts two spaces; over a
 * selection it indents every line it touches. Shift+Tab removes up to two
 * leading spaces (or a tab) from those lines.
 */
export function indentCode(state: EditorState, delta: 1 | -1): EditorState {
  const { anchor, focus } = state.selection;
  if (anchor.blockId !== focus.blockId) return state;
  const block = getBlock(state.doc, focus.blockId);
  if (block.type !== 'code') return state;
  if (delta === 1 && isCollapsed(state.selection)) return insertText(state, CODE_INDENT);
  const text = inlineText(block.content);
  const from = Math.min(anchor.offset, focus.offset);
  const to = Math.max(anchor.offset, focus.offset);
  // Starts of the lines the selection touches, and how much each one changes.
  const edits: { at: number; remove: number }[] = [];
  for (let at = text.lastIndexOf('\n', from - 1) + 1; ; ) {
    const lead = /^(?: {1,2}|\t)/.exec(text.slice(at))?.[0].length ?? 0;
    edits.push({ at, remove: delta === 1 ? 0 : lead });
    const next = text.indexOf('\n', at);
    if (next < 0 || next >= to) break;
    at = next + 1;
  }
  if (delta === -1 && edits.every((e) => e.remove === 0)) return state;
  let out = '';
  let last = 0;
  for (const e of edits) {
    out += text.slice(last, e.at) + (delta === 1 ? CODE_INDENT : '');
    last = e.at + e.remove;
  }
  out += text.slice(last);
  // A position moves by the change at every line start up to it; inside removed indentation, to the line start.
  const map = (offset: number) => {
    let shift = 0;
    for (const e of edits) {
      if (e.at > offset) break;
      shift += delta === 1 ? CODE_INDENT.length : -Math.min(e.remove, offset - e.at);
    }
    return offset + shift;
  };
  const updated = withContent(block, plain(out));
  return replaceBlock(state, updated, {
    anchor: { ...anchor, offset: map(anchor.offset) },
    focus: { ...focus, offset: map(focus.offset) },
  });
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
// Block actions

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
// Whole blocks, for block selection. A range is the indexes of its
// first and last block, inclusive.

export interface BlockRange {
  readonly from: number;
  readonly to: number;
}

/** A selection from the start of the first block in a range to the end of the last. */
export function spanBlocks(blocks: readonly Block[], range: BlockRange): Selection {
  return { anchor: startOf(blocks[range.from]!), focus: endOf(blocks[range.to]!) };
}

/**
 * The deepest `item` can be nested after `prev`: one level below a list item
 * in the same list (inside the same quote, or outside quotes), else top level.
 */
function maxIndent(prev: Block | undefined, item: ListItemBlock): number {
  return prev?.type === 'listItem' && quoteKind(prev) === quoteKind(item) ? Math.min(MAX_INDENT, prev.indent + 1) : 0;
}

/**
 * Lowers list items, starting at `index`, that are nested deeper than the
 * item above allows (one level below it, or top level after a non-list
 * block). Stops at the first item that fits, since everything after it
 * already did. Mutates `blocks`; changed items keep their IDs.
 */
function fitIndents(blocks: Block[], index: number): void {
  for (let i = Math.max(0, index); i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type !== 'listItem') return;
    const max = maxIndent(blocks[i - 1], block);
    if (block.indent <= max) return;
    blocks[i] = { ...block, indent: max };
  }
}

/** Removes whole blocks. The caret goes to the end of the block before them, or the start of the block after. */
export function deleteBlocks(state: EditorState, range: BlockRange): EditorState {
  return replaceBlocks(state, range, []);
}

/** Inserts copies of the blocks right after them, and selects the copies. */
export function duplicateBlocks(state: EditorState, range: BlockRange): EditorState {
  const copies = state.doc.blocks.slice(range.from, range.to + 1).map(cloneBlock);
  const out = splice(state, range.to + 1, 0, ...copies);
  fitIndents(out, range.to + 1);
  const at = { from: range.to + 1, to: range.to + copies.length };
  return withBlocks(state, out, spanBlocks(out, at));
}

/** Replaces whole blocks with `fragment` and puts the caret at its end. An empty fragment deletes them. */
export function replaceBlocks(state: EditorState, range: BlockRange, fragment: readonly Block[]): EditorState {
  const out = splice(state, range.from, range.to - range.from + 1, ...fragment);
  if (out.length === 0) {
    const p = paragraph();
    return withBlocks(state, [p], caret(p.id, 0));
  }
  fitIndents(out, range.from);
  fitIndents(out, range.from + fragment.length);
  let pos: Position;
  if (fragment.length > 0) pos = endOf(out[range.from + fragment.length - 1]!);
  else if (range.from > 0) pos = endOf(out[range.from - 1]!);
  else pos = startOf(out[0]!);
  return withBlocks(state, out, { anchor: pos, focus: pos });
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
const BLOCK_RULES: [RegExp, (m: RegExpExecArray) => BlockTypeSpec][] = [
  [/^(#{1,6}) $/, (m) => ({ type: 'heading', level: m[1]!.length as HeadingLevel })],
  [/^[-*+] $/, () => ({ type: 'listItem', listType: 'bullet' })],
  [/^\d{1,9}[.)] $/, () => ({ type: 'listItem', listType: 'ordered' })],
  [/^\[[ xX]?\] $/, () => ({ type: 'listItem', listType: 'task' })],
  [/^> $/, () => ({ type: 'quote' })],
  [new RegExp(`^\\[!(${CALLOUT_TYPES.join('|')})\\] $`, 'i'), (m) => ({ type: 'quote', callout: m[1]!.toLowerCase() as CalloutType })],
  [/^```([^`\s]*) $/, (m) => ({ type: 'code', language: m[1] })],
  [/^>>> $/, () => ({ type: 'details' })],
];

/**
 * Turns a paragraph into another block type when the text before the caret
 * is a Markdown marker such as "# " or "- ". `dialect` turns off the markers
 * for callouts and collapsible sections, as the Markdown options do.
 */
export function applyBlockInputRules(state: EditorState, dialect: { callouts?: boolean; details?: boolean } = {}): EditorState | null {
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

  // Only "[ ] " applies inside a bullet item (turning "- [ ] " into a task),
  // and only list markers (a list in the quote) and a callout marker such as
  // "[!note] " inside a quote.
  const allowed = block.type === 'paragraph' || block.type === 'quote' || (block.type === 'listItem' && block.listType === 'bullet');
  if (!allowed) return null;
  for (const [re, toSpec] of BLOCK_RULES) {
    const m = re.exec(before);
    if (!m) continue;
    const spec = toSpec(m);
    if ((spec.type === 'quote' && spec.callout && dialect.callouts === false) || (spec.type === 'details' && dialect.details === false)) continue;
    if (block.type === 'listItem' && !(spec.type === 'listItem' && spec.listType === 'task')) continue;
    if (block.type === 'quote' && spec.type !== 'listItem') {
      if (spec.type !== 'quote' || !spec.callout) continue;
      // The whole quote becomes the callout.
      return setCallout(deleteRange(state, { blockId: block.id, offset: 0 }, pos), block.id, spec.callout);
    }
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
        quote: quoteKind(converted),
      });
      next = replaceBlock(next, keepQuoteStart(converted, updated), next.selection);
    }
    return next;
  }
  return null;
}

/** The caret and the inline content it is in, when the selection is collapsed in text that takes marks. */
function inlineAtCaret(state: EditorState): { pos: Position; block: Block; content: Inline } | null {
  if (!isCollapsed(state.selection)) return null;
  const pos = state.selection.focus;
  const block = getBlock(state.doc, pos.blockId);
  if (isPlainTextBlock(block)) return null;
  const content = containerContent(block, pos.cell);
  return content ? { pos, block, content } : null;
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
  const at = inlineAtCaret(state);
  if (!at) return null;
  const { pos, block, content } = at;
  const before = inlineText(content).slice(0, pos.offset);

  for (const rule of INLINE_RULES) {
    const m = rule.re.exec(before);
    if (!m) continue;
    const inner = m[1]!;
    const end = pos.offset;
    const innerEnd = end - rule.delim;
    const innerStart = innerEnd - inner.length;
    const start = innerStart - rule.delim;
    // A backslash escapes a delimiter, as in CommonMark: `\*a*` stays text. Inside code
    // a backslash is literal, so only the opening backtick can be escaped.
    if (isEscaped(before, start) || (rule.mark !== 'code' && isEscaped(before, innerEnd))) continue;
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

/** True when the character at `index` follows an odd number of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let count = 0;
  while (index - count - 1 >= 0 && text[index - count - 1] === '\\') count++;
  return count % 2 === 1;
}

/**
 * Text just typed that completes a token of an inline syntax extension (for
 * example the closing `$` of `$x^2$`) becomes that token, so it is saved
 * verbatim instead of escaped. Only plain text on the caret's line counts.
 */
export function applyTokenInputRules(state: EditorState, syntax: readonly InlineSyntax[]): EditorState | null {
  const at = syntax.length > 0 ? inlineAtCaret(state) : null;
  if (!at) return null;
  const { pos, block, content } = at;
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

/**
 * Removes the token of extension syntax from text that no longer reads as
 * that syntax, such as `^1]` left after deleting the `[` of `[^1]`, so it is
 * shown and saved as the text it now is. Text marked as code loses its token
 * too. A run of one token may hold several tokens written next to each other.
 * Only blocks that changed since `before` are checked.
 */
export function dropBrokenTokens(state: EditorState, before: EditorState, syntax: readonly InlineSyntax[]): EditorState {
  if (syntax.length === 0 || state.doc === before.doc) return state;
  const old = new Set(before.doc.blocks);
  let blocks: Block[] | null = null;
  state.doc.blocks.forEach((block, i) => {
    if (old.has(block) || block.type === 'divider') return;
    const containers: (Cell | undefined)[] =
      block.type === 'table' ? block.rows.flatMap((row, r) => row.map((_, c) => ({ row: r, col: c }))) : [undefined];
    let next: Block = block;
    for (const cell of containers) {
      const content = containerContent(next, cell);
      if (!content?.some((s) => s.token)) continue;
      const fixed = untokenizeBroken(content, syntax);
      if (fixed !== content) next = withContainerContent(next, cell, fixed);
    }
    if (next !== block) (blocks ??= [...state.doc.blocks])[i] = next;
  });
  return blocks ? { ...state, doc: { ...state.doc, blocks } } : state;
}

/**
 * Lowers list items nested deeper than the block above allows: one level
 * below a list item, or not nested after any other block. Markdown cannot
 * write a nested item without its parent, so this is what saving would give.
 * It happens when a parent item becomes another kind of block or is removed.
 */
export function clampListIndents(state: EditorState, before: EditorState): EditorState {
  if (state.doc === before.doc) return state;
  let blocks: Block[] | null = null;
  let max = 0;
  state.doc.blocks.forEach((block, i) => {
    if (block.type !== 'listItem' || quoteKind(block) !== quoteKind(state.doc.blocks[i - 1])) max = 0;
    if (block.type !== 'listItem') return;
    if (block.indent > max) (blocks ??= [...state.doc.blocks])[i] = { ...block, indent: max };
    max = Math.min(block.indent, max) + 1;
  });
  return blocks ? { ...state, doc: { ...state.doc, blocks } } : state;
}

function untokenizeBroken(content: Inline, syntax: readonly InlineSyntax[]): Inline {
  const text = inlineText(content);
  let out: Inline = content;
  let pos = 0;
  for (const span of content) {
    const start = pos;
    const end = (pos += span.text.length);
    if (!span.token) continue;
    // Code is never read as syntax.
    const s = span.marks.includes('code') ? undefined : syntax.find((x) => x.name === span.token);
    let at = start;
    while (s && at < end) {
      const e = s.match(text, at);
      if (e <= at || e > end) break;
      at = e;
    }
    if (at === end) continue;
    const { token: _broken, ...plainSpan } = span;
    out = concatInline(sliceInline(out, 0, start), [plainSpan], sliceInline(out, end));
  }
  return out;
}

/**
 * A GFM autolink literal (a `www.`, `http(s)://` or `ftp://` URL, or an
 * e-mail address) just followed by a typed space becomes a link, the same
 * link it reads back as after saving. Only text that is not code, a link, a
 * token, raw HTML or an image counts.
 */
export function applyAutolinkInputRule(state: EditorState): EditorState | null {
  const at = inlineAtCaret(state);
  if (!at) return null;
  const { pos, block, content } = at;
  const text = inlineText(content);
  const end = pos.offset - 1;
  if (end <= 0 || !/\s/.test(text[end]!)) return null;
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  const word = text.slice(start, end);
  let found: { from: number; to: number; href: string } | null = null;
  for (const m of word.matchAll(/www\.|(?:https?|ftp):\/\//gi)) {
    if (!isLiteralBoundary(m.index === 0 ? undefined : word[m.index! - 1], m[0].toLowerCase() === 'www.')) continue;
    const url = urlLiteralAt(word, m.index!);
    if (url) {
      found = { from: start + m.index!, to: start + url.end, href: url.href };
      break;
    }
  }
  if (!found) {
    const email = emailLiterals(word)[0];
    if (email) found = { from: start + email.from, to: start + email.to, href: 'mailto:' + word.slice(email.from, email.to) };
  }
  if (!found) return null;
  if (sliceInline(content, found.from, found.to).some(isExcluded)) return null;
  const updated = withContainerContent(block, pos.cell, setLinkInRange(content, found.from, found.to, found.href));
  return replaceBlock(state, updated, state.selection);
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
      // Within one table cell: copy the selected text as a paragraph.
      if (block.type === 'table' && start === end && from.cell && sameCell(from.cell, to.cell)) {
        return paragraph(sliceInline(contentOf(block, from.cell), from.offset, to.offset));
      }
      return cloneBlock(block);
    }
    const a = block.id === from.blockId ? from.offset : 0;
    const b = block.id === to.blockId ? to.offset : Infinity;
    return cloneBlock(withContent(block, sliceInline(block.content, a, b)));
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

  // In a table cell, a code block or a raw block, paste as text.
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
    p.blockId === target.blockId && sameCell(p.cell, target.cell) && p.offset > target.offset
      ? { ...after, offset: after.offset + p.offset - target.offset }
      : p;
  const selection = clampSelection(next.doc, { anchor: map(s.selection.anchor), focus: map(s.selection.focus) });
  return { ...next, selection };
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
  if ((tail.type === 'quote' || tail.type === 'listItem') && tail.quoteStart) {
    const { quoteStart: _start, ...rest } = tail;
    tail = rest;
  }
  return end(splice(state, index, 1, head, ...fragment, tail), last, startOf(tail));
}
