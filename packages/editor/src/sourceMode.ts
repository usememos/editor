// Source mode: the whole document as its Markdown text (see docs/architecture.md, "Source mode").
//
// In source mode the state holds one code block, `SOURCE_ID`, whose text is
// the Markdown, edited as plain text. Everything here is a pure function: the
// text edits of source mode, and the mapping of a caret between a rich
// document and its text.

import { type MarkdownSource } from './markdown/source';
import {
  type Block,
  type CodeBlock,
  type Doc,
  type EditorState,
  type Position,
  type Selection,
  codeBlock,
  containerContent,
  inlineText,
  isTextless,
} from './model';

/** The ID of the one block that holds the text in source mode. */
export const SOURCE_ID = 'mbe-source';

export type EditorMode = 'rich' | 'source';

export function sourceDoc(text: string): Doc {
  return { blocks: [codeBlock('', text, SOURCE_ID)] };
}

export function isSourceDoc(doc: Doc): boolean {
  return doc.blocks.length === 1 && doc.blocks[0]!.id === SOURCE_ID;
}

/** The text of a source document. */
export function sourceText(doc: Doc): string {
  return inlineText((doc.blocks[0] as CodeBlock).content);
}

export function sourcePosition(offset: number): Position {
  return { blockId: SOURCE_ID, offset };
}

export function sourceState(text: string, anchor: number, focus = anchor): EditorState {
  return {
    doc: sourceDoc(text),
    selection: { anchor: sourcePosition(clamp(anchor, text)), focus: sourcePosition(clamp(focus, text)) },
    storedMarks: null,
  };
}

function clamp(offset: number, text: string): number {
  return Math.max(0, Math.min(offset, text.length));
}

/** The selected range of a source state, in text order. */
export function sourceRange(state: EditorState): { from: number; to: number } {
  const a = state.selection.anchor.offset;
  const f = state.selection.focus.offset;
  return { from: Math.min(a, f), to: Math.max(a, f) };
}

/** Replaces `[from, to)` with `insert`, and selects `[selFrom, selTo]` in the new text. */
function edit(state: EditorState, from: number, to: number, insert: string, selFrom: number, selTo = selFrom): EditorState {
  const text = sourceText(state.doc);
  return sourceState(text.slice(0, from) + insert + text.slice(to), selFrom, selTo);
}

// ---------------------------------------------------------------------------
// Text edits

/** Inserts text at the selection, replacing it. */
export function insertSourceText(state: EditorState, insert: string): EditorState {
  const { from, to } = sourceRange(state);
  return edit(state, from, to, insert, from + insert.length);
}

/**
 * Inserts text at `offset` without replacing anything. With `block`, the
 * text goes on lines of its own: a line break is added before it unless it
 * starts a line, and after it unless a line break or the end follows.
 */
export function insertSourceAt(state: EditorState, offset: number, insert: string, block: boolean, keepSelection: boolean): EditorState {
  const text = sourceText(state.doc);
  const at = clamp(offset, text);
  let piece = insert;
  if (block) {
    if (at > 0 && text[at - 1] !== '\n') piece = '\n' + piece;
    if (at < text.length && text[at] !== '\n' && !piece.endsWith('\n')) piece += '\n';
  }
  if (keepSelection) {
    const shift = (o: number) => (o >= at ? o + piece.length : o);
    return sourceState(text.slice(0, at) + piece + text.slice(at), shift(state.selection.anchor.offset), shift(state.selection.focus.offset));
  }
  const end = at + piece.length - (block && piece.endsWith('\n') && !insert.endsWith('\n') ? 1 : 0);
  return sourceState(text.slice(0, at) + piece + text.slice(at), end);
}

/** Backspace: deletes the selection or the character before the caret; nothing at the start. */
export function sourceDeleteBackward(state: EditorState, previous: (text: string, offset: number) => number): EditorState | null {
  const { from, to } = sourceRange(state);
  if (from !== to) return edit(state, from, to, '', from);
  if (from === 0) return null;
  const start = previous(sourceText(state.doc), from);
  return edit(state, start, from, '', start);
}

/** Delete: deletes the selection or the character after the caret; nothing at the end. */
export function sourceDeleteForward(state: EditorState, next: (text: string, offset: number) => number): EditorState | null {
  const { from, to } = sourceRange(state);
  if (from !== to) return edit(state, from, to, '', from);
  const text = sourceText(state.doc);
  if (from === text.length) return null;
  return edit(state, from, next(text, from), '', from);
}

/** Where an offset in `before` moves to in `after`, when the change between them is one replaced range. */
export function mapOffset(offset: number, before: string, after: string): number {
  if (before === after) return offset;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  if (offset <= start) return offset;
  if (offset >= endBefore) return offset + (after.length - before.length);
  return endAfter;
}

// ---------------------------------------------------------------------------
// Mapping between a rich document and its text

/** A block's text, where a caret can be in it; null for a table, divider or section end. */
function blockText(block: Block): string | null {
  if (block.type === 'table' || isTextless(block)) return null;
  const content = containerContent(block);
  return content ? inlineText(content) : null;
}

interface Placed {
  /** Where the block's text starts in the source, or its source's start. */
  readonly start: number;
  /** Where the block's source ends. */
  readonly end: number;
  readonly text: string | null;
}

/**
 * Where each loaded block sits in its source: blocks of one group (the items
 * of a list) are found in order, each from the end of the one before.
 */
function placeBlocks(loaded: { doc: Doc; source: MarkdownSource }): Placed[] {
  const src = loaded.source.text;
  const placed: Placed[] = [];
  let lastEnd = 0;
  for (const block of loaded.doc.blocks) {
    const group = loaded.source.groupOf.get(block);
    const text = blockText(block);
    if (!group) {
      placed.push({ start: lastEnd, end: lastEnd, text });
      continue;
    }
    const first = group.blocks[0] === block;
    let cursor = first ? group.from : Math.max(group.from, lastEnd);
    // Past the end of the previous block's line, for the next item of a list.
    if (!first) {
      const nl = src.indexOf('\n', cursor);
      if (nl !== -1 && nl < group.to) cursor = nl + 1;
    }
    let start = cursor;
    if (text) {
      const exact = src.indexOf(text, cursor);
      const head = src.indexOf(text.slice(0, Math.min(text.length, 1)), cursor);
      if (exact !== -1 && exact <= group.to) start = exact;
      else if (head !== -1 && head <= group.to) start = head;
    } else if (block.type !== 'table') {
      // An empty item: after its marker.
      const lineEnd = src.indexOf('\n', cursor);
      start = Math.min(lineEnd === -1 ? group.to : lineEnd, group.to);
    }
    const last = group.blocks[group.blocks.length - 1] === block;
    let end = group.to;
    if (!last) {
      const nl = src.indexOf('\n', start + (text?.length ?? 0));
      end = nl === -1 || nl > group.to ? group.to : nl;
    }
    placed.push({ start, end, text });
    lastEnd = end;
  }
  return placed;
}

/**
 * The offset in `loaded`'s text for a position in a rich document whose
 * blocks match `loaded`'s by index. The caret keeps its column when the
 * block's text before it appears verbatim in the source; otherwise it goes
 * to the start of the block's text.
 */
export function toSourceOffset(doc: Doc, pos: Position, loaded: { doc: Doc; source: MarkdownSource }, placed = placeBlocks(loaded)): number {
  const index = doc.blocks.findIndex((b) => b.id === pos.blockId);
  const at = placed[Math.max(0, Math.min(index, placed.length - 1))];
  if (!at) return 0;
  const block = doc.blocks[index];
  if (!block || pos.cell) return at.start;
  const text = blockText(block);
  if (!text) return at.start;
  const before = text.slice(0, pos.offset);
  const src = loaded.source.text;
  if (src.startsWith(before, at.start)) return at.start + before.length;
  const found = src.indexOf(before, at.start);
  return found !== -1 && found + before.length <= at.end ? found + before.length : at.start;
}

/** The position in `loaded`'s document for an offset in its text: the block whose source holds it, at the same column when it can be. */
export function fromSourceOffset(offset: number, loaded: { doc: Doc; source: MarkdownSource }, placed = placeBlocks(loaded)): Position {
  const blocks = loaded.doc.blocks;
  let index = 0;
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i]!;
    const group = loaded.source.groupOf.get(blocks[i]!);
    const from = group && group.blocks[0] === blocks[i] ? group.from : p.start;
    if (from <= offset) index = i;
    else break;
  }
  const block = blocks[index]!;
  const p = placed[index];
  const text = blockText(block);
  if (block.type === 'table') return { blockId: block.id, offset: 0, cell: { row: 0, col: 0 } };
  if (!p || !text) return { blockId: block.id, offset: 0 };
  const src = loaded.source.text;
  if (offset <= p.start) return { blockId: block.id, offset: 0 };
  const before = src.slice(p.start, offset);
  return { blockId: block.id, offset: text.startsWith(before) ? before.length : 0 };
}

/** Maps a selection of a rich document to offsets in `loaded`'s text. */
export function selectionToSource(doc: Doc, sel: Selection, loaded: { doc: Doc; source: MarkdownSource }): { anchor: number; focus: number } {
  const placed = placeBlocks(loaded);
  return { anchor: toSourceOffset(doc, sel.anchor, loaded, placed), focus: toSourceOffset(doc, sel.focus, loaded, placed) };
}

/** Maps offsets in a text to a selection of `loaded`, the document loaded from it. */
export function selectionFromSource(anchor: number, focus: number, loaded: { doc: Doc; source: MarkdownSource }): Selection {
  const placed = placeBlocks(loaded);
  return { anchor: fromSourceOffset(anchor, loaded, placed), focus: fromSourceOffset(focus, loaded, placed) };
}

/** Where a block's source ends in `loaded`'s text, for a widget that follows the block. */
export function blockEndOffset(doc: Doc, blockId: string, loaded: { doc: Doc; source: MarkdownSource }): number {
  const placed = placeBlocks(loaded);
  const index = doc.blocks.findIndex((b) => b.id === blockId);
  return placed[Math.max(0, Math.min(index, placed.length - 1))]?.end ?? loaded.source.text.length;
}
