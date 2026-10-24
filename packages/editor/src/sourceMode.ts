// Source mode: the whole document as its Markdown text (see docs/architecture.md, "Source mode").
//
// In source mode the state holds one code block, `SOURCE_ID`, whose text is
// the Markdown, edited as plain text. Everything here is a pure function: the
// text edits of source mode, and the mapping of a caret between a rich
// document and its text.

import { type MarkdownSource } from './markdown/source';
import type { Range } from './markdown/ast';
import { type Segment, fromSource, sourceSpan, toSource } from './markdown/sourceMap';
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

// ---------------------------------------------------------------------------
// Lists: Enter continues a list item, Tab and Shift+Tab nest it
//
// These read the lines around the caret as Markdown list items and make
// ordinary text edits, so the text stays the only state and undo works as for
// typing. Lines inside fenced code are never list items.

/** A list item's marker on a line of source text. Offsets are into the whole text. */
interface ListMarker {
  readonly ordered: boolean;
  /** `-`, `*` or `+`, or the delimiter after an ordered item's number: `.` or `)`. */
  readonly char: string;
  readonly number: number;
  /** Where the marker (`-` or `12.`) starts and ends. */
  readonly from: number;
  readonly to: number;
  /** False for a marker at the end of its line with no space after it, as in `-`. */
  readonly spaced: boolean;
  /** Where the task box starts, or -1. */
  readonly box: number;
  /** Where the item's text starts: after the marker, its spaces and a task box. */
  readonly content: number;
  /** The column the item's text starts at, after any quote markers: where a nested item's marker goes. */
  readonly column: number;
}

interface SourceLine {
  readonly from: number;
  readonly to: number;
  /** How many quote markers (`>`) start the line, and where they end. */
  readonly depth: number;
  readonly quoteEnd: number;
  /** The width in columns of the indentation after the quote markers, and where it ends. */
  readonly indent: number;
  readonly indentEnd: number;
  readonly blank: boolean;
  readonly item: ListMarker | null;
}

interface TextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

const QUOTE_MARKERS = /^(?: {0,3}>[ \t]?)*/;
const LIST_MARKER = /^(?:([-*+])|(\d{1,9})([.)]))(?=[ \t]|$)/;
const THEMATIC_BREAK = /^([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;

/** The width of leading whitespace in columns, with tab stops every 4 columns. */
function columns(space: string, start = 0): number {
  let col = start;
  for (const c of space) col = c === '\t' ? col + 4 - (col % 4) : col + 1;
  return col - start;
}

function parseMarker(body: string, at: number, indent: number): ListMarker | null {
  if (THEMATIC_BREAK.test(body)) return null;
  const m = LIST_MARKER.exec(body);
  if (!m) return null;
  let pos = m[0].length;
  const space = /^[ \t]*/.exec(body.slice(pos))![0];
  const width = columns(space, indent + pos);
  pos += space.length;
  let box = -1;
  if (space && /^\[[ xX]\](?=[ \t]|$)/.test(body.slice(pos))) {
    box = at + pos;
    pos += 3;
    pos += /^[ \t]*/.exec(body.slice(pos))![0].length;
  }
  return {
    ordered: !m[1],
    char: m[1] ?? m[3]!,
    number: m[2] ? Number(m[2]) : 0,
    from: at,
    to: at + m[0].length,
    spaced: space.length > 0,
    box,
    content: at + pos,
    // CommonMark: one to four spaces after the marker set the text's column; more start indented code.
    column: indent + m[0].length + (width >= 1 && width <= 4 ? width : 1),
  };
}

/** Every line of a text, with its quote markers, indentation and list marker. */
function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let fence: { char: string; length: number } | null = null;
  for (let from = 0; ; ) {
    const nl = text.indexOf('\n', from);
    const to = nl === -1 ? text.length : nl;
    const line = text.slice(from, to);
    const quote = QUOTE_MARKERS.exec(line)![0];
    const space = /^[ \t]*/.exec(line.slice(quote.length))![0];
    const indentEnd = from + quote.length + space.length;
    const body = line.slice(quote.length + space.length);
    const indent = columns(space);
    let code = fence !== null;
    const f = FENCE.exec(body);
    if (fence) {
      if (f && f[1]![0] === fence.char && f[1]!.length >= fence.length && f[2]!.trim() === '') fence = null;
    } else if (f && !(f[1]![0] === '`' && f[2]!.includes('`'))) {
      fence = { char: f[1]![0]!, length: f[1]!.length };
      code = true;
    }
    lines.push({
      from,
      to,
      depth: quote.split('>').length - 1,
      quoteEnd: from + quote.length,
      indent,
      indentEnd,
      blank: body.trim() === '',
      item: code ? null : parseMarker(body, indentEnd, indent),
    });
    if (nl === -1) return lines;
    from = nl + 1;
  }
}

/**
 * False when the line that holds `offset` cannot be a list item, so the whole
 * text need not be read. A line that can be one may still be in fenced code.
 */
function mayBeItem(text: string, offset: number): boolean {
  const end = text.indexOf('\n', offset);
  const line = text.slice(text.lastIndexOf('\n', offset - 1) + 1, end === -1 ? text.length : end);
  return LIST_MARKER.test(line.replace(QUOTE_MARKERS, '').trimStart());
}

/** The index of the line that holds `offset`. */
function lineAt(lines: readonly SourceLine[], offset: number): number {
  let i = 0;
  while (i + 1 < lines.length && lines[i + 1]!.from <= offset) i++;
  return i;
}

/** The previous item at the same indentation, which a nested item goes under; -1 when the item is the first of its list. */
function previousSibling(lines: readonly SourceLine[], i: number): number {
  const line = lines[i]!;
  for (let j = i - 1; j >= 0; j--) {
    const l = lines[j]!;
    if (l.blank) continue;
    if (l.depth !== line.depth) return -1;
    if (l.indent > line.indent) continue;
    return l.item && l.indent === line.indent ? j : -1;
  }
  return -1;
}

/** The item a nested item is in: the nearest item above with less indentation, or -1. */
function parentItem(lines: readonly SourceLine[], i: number): number {
  const line = lines[i]!;
  for (let j = i - 1; j >= 0; j--) {
    const l = lines[j]!;
    if (l.blank) continue;
    if (l.depth !== line.depth) return -1;
    if (l.indent < line.indent) return l.item ? j : -1;
  }
  return -1;
}

/** The items of the list that line `i` is an item of, in order: same indentation, same kind of marker. */
function listRun(lines: readonly SourceLine[], i: number): number[] {
  const line = lines[i]!;
  const item = line.item!;
  const same = (l: SourceLine) => l.item !== null && l.indent === line.indent && l.item.ordered === item.ordered && l.item.char === item.char;
  const run = [i];
  for (const step of [-1, 1]) {
    for (let j = i + step; j >= 0 && j < lines.length; j += step) {
      const l = lines[j]!;
      if (l.blank) continue;
      if (l.depth !== line.depth) break;
      if (l.indent > line.indent) continue;
      if (!same(l)) break;
      if (step < 0) run.unshift(j);
      else run.push(j);
    }
  }
  return run;
}

/**
 * Numbers the ordered lists that lines `targets` are items of, from the
 * list's first number, or from 1 when its first item is in `fresh` (an item
 * that just started the list). A list numbered `1.`, `1.`, `1.` keeps that
 * style: its fresh items take the same number.
 */
function renumber(lines: readonly SourceLine[], targets: Iterable<number>, fresh: ReadonlySet<number>): TextChange[] {
  const changes: TextChange[] = [];
  const done = new Set<number>();
  for (const target of targets) {
    if (!lines[target]?.item?.ordered) continue;
    const run = listRun(lines, target);
    if (done.has(run[0]!)) continue;
    done.add(run[0]!);
    const settled = run.filter((j) => !fresh.has(j)).map((j) => lines[j]!.item!.number);
    const lazy = settled.length >= 2 && settled.every((n) => n === settled[0]);
    const start = fresh.has(run[0]!) ? 1 : lines[run[0]!]!.item!.number;
    run.forEach((j, k) => {
      const item = lines[j]!.item!;
      const number = lazy ? (fresh.has(j) ? settled[0]! : item.number) : start + k;
      if (number !== item.number) changes.push({ from: item.from, to: item.to - 1, insert: String(number) });
    });
  }
  return changes;
}

/**
 * Where an offset moves to through changes sorted by position. Text inserted
 * at the offset goes before it; inside a replaced range, it stays within the
 * replacement.
 */
function mapThrough(offset: number, changes: readonly TextChange[]): number {
  let shift = 0;
  for (const c of changes) {
    if (c.from > offset || (c.from === offset && c.to > c.from)) break;
    if (offset >= c.to) shift += c.insert.length - (c.to - c.from);
    else return c.from + shift + Math.min(offset - c.from, c.insert.length);
  }
  return offset + shift;
}

function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = '';
  let last = 0;
  for (const c of changes) {
    out += text.slice(last, c.from) + c.insert;
    last = c.to;
  }
  return out + text.slice(last);
}

/**
 * Applies `changes`, then numbers the lists of the lines at `targets`
 * (offsets into the changed text, see `renumber`). `anchor` and `focus` are
 * offsets into `text`, or into the changed text when `mapped`.
 */
function finish(text: string, changes: TextChange[], anchor: number, focus: number, targets: number[], fresh: number[], mapped = false): EditorState {
  changes.sort((a, b) => a.from - b.from);
  let next = applyChanges(text, changes);
  let a = mapped ? anchor : mapThrough(anchor, changes);
  let f = mapped ? focus : mapThrough(focus, changes);
  const lines = sourceLines(next);
  const numbers = renumber(
    lines,
    targets.map((o) => lineAt(lines, o)),
    new Set(fresh.map((o) => lineAt(lines, o))),
  );
  if (numbers.length) {
    next = applyChanges(next, numbers);
    a = mapThrough(a, numbers);
    f = mapThrough(f, numbers);
  }
  return sourceState(next, a, f);
}

/**
 * Moves list lines `first` to `last`, and the lines nested under the last,
 * by `delta` columns, and numbers the lists they left and joined.
 */
function shiftItems(text: string, lines: readonly SourceLine[], first: number, last: number, delta: number, anchor: number, focus: number): EditorState {
  const line = lines[first]!;
  let end = last;
  for (let j = last + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.blank) continue;
    if (l.depth !== line.depth || l.indent <= lines[last]!.indent) break;
    end = j;
  }
  const changes: TextChange[] = [];
  for (let j = first; j <= end; j++) {
    const l = lines[j]!;
    if (l.blank || l.depth !== line.depth) continue;
    changes.push({ from: l.quoteEnd, to: l.indentEnd, insert: ' '.repeat(Math.max(0, l.indent + delta)) });
  }
  // The item after the moved lines at their old indentation: the list it is in lost them, or (after an outdent) it is nested now.
  let after = -1;
  for (let j = end + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.blank) continue;
    if (l.depth === line.depth && l.indent === line.indent && l.item) after = j;
    break;
  }
  const moved = mapThrough(line.indentEnd, changes);
  const following = after === -1 ? [] : [mapThrough(lines[after]!.indentEnd, changes)];
  return finish(text, changes, anchor, focus, [moved, ...following], [moved, ...(delta < 0 ? following : [])]);
}

/**
 * Enter in source mode: on a list item, continues the list (the next number,
 * an unticked task box); on an empty item, removes the marker, or outdents a
 * nested item, as Enter in an empty item does in rich mode. Elsewhere, and
 * before an item's marker, a line break.
 */
export function sourceEnter(state: EditorState): EditorState {
  const { from, to } = sourceRange(state);
  const whole = sourceText(state.doc);
  const text = whole.slice(0, from) + whole.slice(to);
  if (!mayBeItem(text, from)) return insertSourceText(state, '\n');
  const lines = sourceLines(text);
  const i = lineAt(lines, from);
  const line = lines[i]!;
  const item = line.item;
  if (!item || !item.spaced || from < item.content) return insertSourceText(state, '\n');
  if (text.slice(item.content, line.to).trim() === '') {
    const parent = parentItem(lines, i);
    if (line.indent > 0 && parent !== -1) return shiftItems(text, lines, i, i, lines[parent]!.indent - line.indent, line.to, line.to);
    // Remove the marker, keeping quote markers; the next item's list starts after the blank line.
    const next = lines.findIndex((l, j) => j > i && !l.blank);
    const changes = [{ from: line.quoteEnd, to: line.to, insert: '' }];
    const targets = next === -1 || !lines[next]!.item ? [] : [mapThrough(lines[next]!.indentEnd, changes)];
    return finish(text, changes, line.quoteEnd, line.quoteEnd, targets, []);
  }
  const marker = item.ordered ? `${item.number + 1}${item.char}` : item.char;
  const space = text.slice(item.to, item.box === -1 ? item.content : item.box);
  const box = item.box === -1 ? '' : '[ ]' + (text.slice(item.box + 3, item.content) || ' ');
  const head = text.slice(line.from, line.indentEnd) + marker + space + box;
  // The text after the caret moves to the new item, without the spaces before it.
  const restStart = from + /^[ \t]*/.exec(text.slice(from, line.to))![0].length;
  const changes = [{ from, to: restStart, insert: '\n' + head }];
  const caret = from + 1 + head.length;
  return finish(text, changes, caret, caret, [caret], [caret], true);
}

/**
 * Tab and Shift+Tab in source mode on list items: nests the items under the
 * item before them, or moves them out to their parent's level, with the
 * lines nested under them, and numbers the lists they left and joined.
 * Returns null when the selection is not on list items, for indenting as in
 * a code block; returns the state unchanged when the item cannot move.
 */
export function sourceIndentList(state: EditorState, delta: 1 | -1): EditorState | null {
  const { from, to } = sourceRange(state);
  const text = sourceText(state.doc);
  if (!mayBeItem(text, from)) return null;
  const lines = sourceLines(text);
  const first = lineAt(lines, from);
  let last = lineAt(lines, to);
  // A selection that ends at the start of a line does not include that line.
  if (last > first && to === lines[last]!.from) last--;
  const line = lines[first]!;
  if (!line.item) return null;
  for (let j = first + 1; j <= last; j++) {
    const l = lines[j]!;
    if (!l.blank && (l.depth !== line.depth || (!l.item && l.indent <= line.indent))) return null;
  }
  let target: number;
  if (delta === 1) {
    const sibling = previousSibling(lines, first);
    if (sibling === -1) return state;
    target = lines[sibling]!.item!.column;
  } else {
    if (line.indent === 0) return state;
    const parent = parentItem(lines, first);
    target = parent === -1 ? 0 : lines[parent]!.indent;
  }
  if (target === line.indent) return state;
  return shiftItems(text, lines, first, last, target - line.indent, state.selection.anchor.offset, state.selection.focus.offset);
}

/** Where an offset in `before` moves to in `after`, when the change between them is one replaced range. */
/** The one range an edit replaced: `[from, toBefore)` of `before` became `[from, toAfter)` of `after`. */
export function changedRange(before: string, after: string): { from: number; toBefore: number; toAfter: number } {
  let from = 0;
  const max = Math.min(before.length, after.length);
  while (from < max && before.charCodeAt(from) === after.charCodeAt(from)) from++;
  let suffix = 0;
  while (suffix < max - from && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  return { from, toBefore: before.length - suffix, toAfter: after.length - suffix };
}

export function mapOffset(offset: number, before: string, after: string): number {
  if (before === after) return offset;
  const { from, toBefore, toAfter } = changedRange(before, after);
  if (offset <= from) return offset;
  if (offset >= toBefore) return offset + (after.length - before.length);
  return toAfter;
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
  /** The block's source map and the source range its text covers, when loading made one (see `markdown/sourceMap.ts`). */
  readonly segments: readonly Segment[] | null;
  readonly span: Range | null;
}

/**
 * Where each loaded block sits in its source. A block with a source map
 * starts where its first text does; other blocks of a group (the items of a
 * list) are found in order, each from the end of the one before.
 */
function placeBlocks(loaded: { doc: Doc; source: MarkdownSource }): Placed[] {
  const src = loaded.source.text;
  const placed: Placed[] = [];
  let lastEnd = 0;
  for (const block of loaded.doc.blocks) {
    const group = loaded.source.groupOf.get(block);
    const text = blockText(block);
    const span = sourceSpan(loaded.source.mapOf.get(block));
    const segments = span ? loaded.source.mapOf.get(block)! : null;
    if (!group) {
      placed.push({ start: lastEnd, end: lastEnd, text, segments, span });
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
    let textEnd = cursor;
    if (span) {
      start = span.from;
      textEnd = span.to;
    } else if (text) {
      const exact = src.indexOf(text, cursor);
      const head = src.indexOf(text.slice(0, Math.min(text.length, 1)), cursor);
      if (exact !== -1 && exact <= group.to) start = exact;
      else if (head !== -1 && head <= group.to) start = head;
      textEnd = start + text.length;
    } else if (block.type !== 'table') {
      // An empty item: after its marker.
      const lineEnd = src.indexOf('\n', cursor);
      start = textEnd = Math.min(lineEnd === -1 ? group.to : lineEnd, group.to);
    }
    const last = group.blocks[group.blocks.length - 1] === block;
    let end = group.to;
    if (!last) {
      const nl = src.indexOf('\n', textEnd);
      end = nl === -1 || nl > group.to ? group.to : nl;
    }
    placed.push({ start, end, text, segments, span });
    lastEnd = end;
  }
  return placed;
}

/**
 * The offset in `loaded`'s text for a position in a rich document whose
 * blocks match `loaded`'s by index. With the block's source map, the caret
 * keeps its place in the text, past any syntax before it (an offset on
 * syntax goes to the text after it). Without one, a table or a section, it
 * keeps its column when the block's text before it appears verbatim in the
 * source; otherwise it goes to the start of the block's text.
 */
export function toSourceOffset(doc: Doc, pos: Position, loaded: { doc: Doc; source: MarkdownSource }, placed = placeBlocks(loaded)): number {
  const index = doc.blocks.findIndex((b) => b.id === pos.blockId);
  const at = placed[Math.max(0, Math.min(index, placed.length - 1))];
  if (!at) return 0;
  const block = doc.blocks[index];
  if (!block || pos.cell) return at.start;
  const text = blockText(block);
  if (!text) return at.start;
  if (at.segments) return toSource(at.segments, clamp(pos.offset, text));
  const before = text.slice(0, pos.offset);
  const src = loaded.source.text;
  if (src.startsWith(before, at.start)) return at.start + before.length;
  const found = src.indexOf(before, at.start);
  return found !== -1 && found + before.length <= at.end ? found + before.length : at.start;
}

/**
 * The position in `loaded`'s document for an offset in its text: the block
 * whose source holds it, at the same place in its text. An offset on syntax
 * goes to the text after it, and one inside an image or an escape before it.
 */
export function fromSourceOffset(offset: number, loaded: { doc: Doc; source: MarkdownSource }, placed = placeBlocks(loaded)): Position {
  const blocks = loaded.doc.blocks;
  const src = loaded.source.text;
  // The block whose text holds the offset; otherwise the last block that starts at or before it.
  let index = placed.findIndex((p) => p.span !== null && p.span.from <= offset && offset <= p.span.to);
  if (index === -1) {
    index = 0;
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i]!;
      const group = loaded.source.groupOf.get(blocks[i]!);
      // A group's first block owns the group's start; a later one owns its line from its start.
      const from = group && group.blocks[0] === blocks[i] ? group.from : p.segments ? src.lastIndexOf('\n', p.start - 1) + 1 : p.start;
      if (from <= offset) index = i;
      else break;
    }
  }
  const block = blocks[index]!;
  const p = placed[index];
  const text = blockText(block);
  if (block.type === 'table') return { blockId: block.id, offset: 0, cell: { row: 0, col: 0 } };
  if (!p || !text) return { blockId: block.id, offset: 0 };
  if (p.segments) return { blockId: block.id, offset: clamp(fromSource(p.segments, offset), text) };
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
