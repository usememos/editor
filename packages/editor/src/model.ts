// Document model.
//
// A document is a flat, ordered list of blocks. Blocks are immutable: every
// edit produces new block objects for the blocks it touches and reuses the
// rest. The view relies on this to re-render only blocks whose object
// identity changed, and history relies on it to keep snapshots cheap.

/** `html` marks raw inline HTML, which is shown as source and saved verbatim. */
export type Mark = 'bold' | 'italic' | 'strike' | 'code' | 'html';

/** Canonical mark order. Used for sorting and for nesting when rendering. */
export const MARK_ORDER: readonly Mark[] = ['bold', 'italic', 'strike', 'code', 'html'];

/** Character used as the text of an inline atom (an image). */
export const ATOM_CHAR = '￼';

/** Where an image block sits in its column. Without one it sits at the start of the line. */
export type ImageAlign = 'left' | 'center' | 'right';

export interface ImageAtom {
  readonly src: string;
  readonly alt: string;
  readonly title?: string;
  /**
   * Alignment, saved after the alt text and before the size:
   * `![alt|center](src)` or `![alt|center|320](src)`. It shows only on an
   * image block, an image alone in its paragraph (see `isImageBlock`).
   */
  readonly align?: ImageAlign;
  /**
   * Display width in CSS pixels, saved after the alt text as in Obsidian:
   * `![alt|320](src)`. Without it the image shows at its own size.
   */
  readonly width?: number;
  /** Display height in CSS pixels, saved as `![alt|320x200](src)`. Only read when a width is given. */
  readonly height?: number;
}

/** A run of text that shares one format. A hard line break is a "\n" in the text. */
export interface Span {
  readonly text: string;
  /** Sorted by MARK_ORDER, no duplicates. */
  readonly marks: readonly Mark[];
  readonly link?: string;
  /** An image. Its `text` is a single ATOM_CHAR. */
  readonly image?: ImageAtom;
  /**
   * A token of an inline syntax extension, by syntax name (for example
   * `math`). Its `text` is the token's Markdown source, saved verbatim.
   */
  readonly token?: string;
}

/** Inline content: normalized spans (no empty spans, no adjacent spans with equal format). */
export type Inline = readonly Span[];

export interface Format {
  readonly marks: readonly Mark[];
  readonly link?: string;
  readonly token?: string;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
export type ListType = 'bullet' | 'ordered' | 'task';
export type Align = 'left' | 'center' | 'right' | null;

export const MAX_INDENT = 5;

export interface ParagraphBlock {
  readonly id: string;
  readonly type: 'paragraph';
  readonly content: Inline;
}

export interface HeadingBlock {
  readonly id: string;
  readonly type: 'heading';
  readonly level: HeadingLevel;
  readonly content: Inline;
}

/** One list item. Adjacent items form a list; `indent` gives nesting (0 to MAX_INDENT). */
export interface ListItemBlock {
  readonly id: string;
  readonly type: 'listItem';
  readonly listType: ListType;
  readonly indent: number;
  /** Task items only. */
  readonly checked: boolean;
  /** Ordered items only: the number of the first item of a list. Ignored on later items. */
  readonly start?: number;
  readonly content: Inline;
}

export interface QuoteBlock {
  readonly id: string;
  readonly type: 'quote';
  readonly content: Inline;
}

/** Code block. Content is plain text (no marks); lines are separated by "\n". */
export interface CodeBlock {
  readonly id: string;
  readonly type: 'code';
  readonly language: string;
  readonly content: Inline;
}

/**
 * Markdown kept as source, shown and edited as plain text and saved
 * verbatim. `syntax` says what it is: `html` for an HTML block, `markdown`
 * for structure the editor cannot edit as blocks (a list inside a quote, a
 * code block inside a list item), or the name of a syntax extension.
 */
export interface RawBlock {
  readonly id: string;
  readonly type: 'raw';
  readonly syntax: string;
  readonly content: Inline;
}

/** GFM table. `rows[0]` is the header row. Every row has `align.length` cells. */
export interface TableBlock {
  readonly id: string;
  readonly type: 'table';
  readonly align: readonly Align[];
  readonly rows: readonly (readonly Inline[])[];
}

export interface DividerBlock {
  readonly id: string;
  readonly type: 'divider';
}

export type TextBlock = ParagraphBlock | HeadingBlock | ListItemBlock | QuoteBlock | CodeBlock | RawBlock;
export type Block = TextBlock | TableBlock | DividerBlock;
export type BlockType = Block['type'];

export interface Doc {
  readonly blocks: readonly Block[];
}

export interface Cell {
  readonly row: number;
  readonly col: number;
}

/**
 * A caret position: a character offset into a block's text. Inside a table
 * the position also names the cell. A divider only has offset 0.
 */
export interface Position {
  readonly blockId: string;
  readonly offset: number;
  readonly cell?: Cell;
}

export interface Selection {
  readonly anchor: Position;
  readonly focus: Position;
}

export interface EditorState {
  readonly doc: Doc;
  readonly selection: Selection;
  /** Format for the next typed text, set by toggling a mark on a collapsed selection. */
  readonly storedMarks: readonly Mark[] | null;
}

// ---------------------------------------------------------------------------
// IDs

let idCounter = 0;
const idPrefix = Math.random().toString(36).slice(2, 7);

export function createId(): string {
  idCounter += 1;
  return `${idPrefix}${idCounter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Block constructors

export function paragraph(content: Inline = [], id = createId()): ParagraphBlock {
  return { id, type: 'paragraph', content: normalizeInline(content) };
}

export function heading(level: HeadingLevel, content: Inline = [], id = createId()): HeadingBlock {
  return { id, type: 'heading', level, content: normalizeInline(content) };
}

export function listItem(
  listType: ListType,
  content: Inline = [],
  opts: { indent?: number; checked?: boolean; start?: number; id?: string } = {},
): ListItemBlock {
  const block: ListItemBlock = {
    id: opts.id ?? createId(),
    type: 'listItem',
    listType,
    indent: Math.max(0, Math.min(MAX_INDENT, opts.indent ?? 0)),
    checked: listType === 'task' ? (opts.checked ?? false) : false,
    content: normalizeInline(content),
  };
  return listType === 'ordered' && opts.start !== undefined && opts.start !== 1 ? { ...block, start: opts.start } : block;
}

export function quote(content: Inline = [], id = createId()): QuoteBlock {
  return { id, type: 'quote', content: normalizeInline(content) };
}

export function codeBlock(language = '', text = '', id = createId()): CodeBlock {
  return { id, type: 'code', language, content: plain(text) };
}

export function rawBlock(syntax: string, text = '', id = createId()): RawBlock {
  return { id, type: 'raw', syntax, content: plain(text) };
}

/** A raw HTML block. */
export function htmlBlock(text = '', id = createId()): RawBlock {
  return rawBlock('html', text, id);
}

export function table(align: readonly Align[], rows: readonly (readonly Inline[])[], id = createId()): TableBlock {
  return {
    id,
    type: 'table',
    align,
    rows: rows.map((row) => align.map((_, c) => normalizeInline(row[c] ?? []))),
  };
}

export function emptyTable(rows = 3, cols = 3, id = createId()): TableBlock {
  return table(
    Array.from({ length: cols }, () => null),
    Array.from({ length: rows }, () => Array.from({ length: cols }, () => [])),
    id,
  );
}

export function divider(id = createId()): DividerBlock {
  return { id, type: 'divider' };
}

export function plain(text: string): Span[] {
  return text ? [{ text, marks: [] }] : [];
}

// ---------------------------------------------------------------------------
// Block kinds

export function isTextBlock(block: Block): block is TextBlock {
  return block.type !== 'table' && block.type !== 'divider';
}

/** Blocks whose content is plain text: no marks, links or images, and Enter inserts a newline. */
export function isPlainTextBlock(block: Block): block is CodeBlock | RawBlock {
  return block.type === 'code' || block.type === 'raw';
}

/** Inline content at a position's container: the block's content, or a table cell. Null for dividers. */
/**
 * The offset of the image in an image block, or null when `block` is not one.
 * An image block is a paragraph whose only content is one image, with no link
 * or format, and at most spaces around it. Markdown renders such a paragraph
 * as a lone image, so the editor gives it a block menu and alignment.
 */
export function imageBlockOffset(block: Block): number | null {
  if (block.type !== 'paragraph') return null;
  let offset: number | null = null;
  let at = 0;
  for (const span of block.content) {
    if (span.image) {
      if (offset !== null || span.link || span.marks.length > 0) return null;
      offset = at;
    } else if (span.token || span.link || !/^[ \t]*$/.test(span.text)) {
      return null;
    }
    at += span.text.length;
  }
  return offset;
}

/** True when `block` is an image block (see `imageBlockOffset`). */
export function isImageBlock(block: Block): boolean {
  return imageBlockOffset(block) !== null;
}

export function containerContent(block: Block, cell?: Cell): Inline | null {
  if (block.type === 'table') {
    if (!cell) return null;
    return block.rows[cell.row]?.[cell.col] ?? null;
  }
  if (block.type === 'divider') return null;
  return block.content;
}

/** Returns the block with new content at a container. */
export function withContainerContent(block: Block, cell: Cell | undefined, content: Inline): Block {
  if (block.type === 'table') {
    if (!cell) return block;
    const rows = block.rows.map((row, r) =>
      r === cell.row ? row.map((c, i) => (i === cell.col ? normalizeInline(content) : c)) : row,
    );
    return { ...block, rows };
  }
  if (block.type === 'divider') return block;
  return withContent(block, content);
}

export function withContent<B extends TextBlock>(block: B, content: Inline): B {
  const normalized = isPlainTextBlock(block) ? toPlain(content) : normalizeInline(content);
  return { ...block, content: normalized };
}

/** Drops all formatting. Images become their alt text. */
export function toPlain(inline: Inline): Span[] {
  return plain(inline.map((s) => (s.image ? s.image.alt : s.text)).join(''));
}

// ---------------------------------------------------------------------------
// Marks and format

export function sortMarks(marks: Iterable<Mark>): Mark[] {
  const set = new Set(marks);
  return MARK_ORDER.filter((m) => set.has(m));
}

export function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

function sameFormat(a: Span, b: Span): boolean {
  return !a.image && !b.image && a.link === b.link && a.token === b.token && sameMarks(a.marks, b.marks);
}

// ---------------------------------------------------------------------------
// Inline operations. Offsets are UTF-16 code unit offsets into the plain text.

export function inlineText(inline: Inline): string {
  return inline.map((s) => s.text).join('');
}

export function inlineLength(inline: Inline): number {
  let n = 0;
  for (const s of inline) n += s.text.length;
  return n;
}

export function normalizeInline(inline: Inline): Span[] {
  const out: Span[] = [];
  for (const span of inline) {
    if (span.text.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && sameFormat(prev, span)) {
      out[out.length - 1] = { ...prev, text: prev.text + span.text };
    } else {
      out.push(span);
    }
  }
  return out;
}

export function sliceInline(inline: Inline, from: number, to = Infinity): Span[] {
  const out: Span[] = [];
  let pos = 0;
  for (const span of inline) {
    const end = pos + span.text.length;
    const a = Math.max(from, pos);
    const b = Math.min(to, end);
    if (a < b) out.push(a === pos && b === end ? span : { ...span, text: span.text.slice(a - pos, b - pos) });
    pos = end;
  }
  return out;
}

export function concatInline(...parts: Inline[]): Span[] {
  return normalizeInline(parts.flat());
}

function spanAt(inline: Inline, offset: number): Span | undefined {
  let pos = 0;
  for (const span of inline) {
    const end = pos + span.text.length;
    if (offset >= pos && offset < end) return span;
    pos = end;
  }
  return undefined;
}

/** Marks of the character before `offset`, or after it at offset 0. */
export function marksAt(inline: Inline, offset: number): readonly Mark[] {
  const span = offset > 0 ? spanAt(inline, offset - 1) : spanAt(inline, 0);
  return span && !span.image ? span.marks : [];
}

/**
 * Format for text typed at `offset`. Marks come from the character before.
 * A link is continued only when the caret is inside it, not at its edge.
 */
export function formatAt(inline: Inline, offset: number): Format {
  const marks = marksAt(inline, offset);
  const before = offset > 0 ? spanAt(inline, offset - 1) : undefined;
  const after = spanAt(inline, offset);
  const link = before?.link && before.link === after?.link ? before.link : undefined;
  // Text typed inside a token is part of its source; at its edges it is not.
  const token = before?.token && before.token === after?.token ? before.token : undefined;
  const format: Format = link ? { marks, link } : { marks };
  return token ? { ...format, token } : format;
}

export function insertInline(inline: Inline, offset: number, text: string, format: Format): Span[] {
  let span: Span = format.link ? { text, marks: format.marks, link: format.link } : { text, marks: format.marks };
  if (format.token) span = { ...span, token: format.token };
  return concatInline(sliceInline(inline, 0, offset), [span], sliceInline(inline, offset));
}

export function deleteInline(inline: Inline, from: number, to: number): Span[] {
  return concatInline(sliceInline(inline, 0, from), sliceInline(inline, to));
}

/** True if every non-atom character in [from, to) carries `mark`. */
export function rangeHasMark(inline: Inline, from: number, to: number, mark: Mark): boolean {
  const slice = sliceInline(inline, from, to).filter((s) => !s.image);
  return slice.length > 0 && slice.every((s) => s.marks.includes(mark));
}

export function setMarkInRange(inline: Inline, from: number, to: number, mark: Mark, on: boolean): Span[] {
  const middle = sliceInline(inline, from, to).map((s) =>
    s.image ? s : { ...s, marks: on ? sortMarks([...s.marks, mark]) : s.marks.filter((m) => m !== mark) },
  );
  return concatInline(sliceInline(inline, 0, from), middle, sliceInline(inline, to));
}

/** Makes [from, to) one token of an inline syntax extension. */
export function setTokenInRange(inline: Inline, from: number, to: number, token: string): Span[] {
  const middle = sliceInline(inline, from, to).map((s) => ({ ...s, token }));
  return concatInline(sliceInline(inline, 0, from), middle, sliceInline(inline, to));
}

/** Sets (or with `href` null, removes) a link on [from, to). */
export function setLinkInRange(inline: Inline, from: number, to: number, href: string | null): Span[] {
  const middle = sliceInline(inline, from, to).map((s) => {
    if (s.image) return s;
    const { link: _old, ...rest } = s;
    return href ? { ...rest, link: href } : rest;
  });
  return concatInline(sliceInline(inline, 0, from), middle, sliceInline(inline, to));
}

/** Extension tokens that touch an offset, edges included, with their start offsets. At most two. */
export function tokensAt(inline: Inline, offset: number): { token: string; from: number }[] {
  const out: { token: string; from: number }[] = [];
  let pos = 0;
  for (const span of inline) {
    if (pos > offset) break;
    const end = pos + span.text.length;
    if (span.token && offset <= end) out.push({ token: span.token, from: pos });
    pos = end;
  }
  return out;
}

/** The link at an offset (the character after it, or before it at the end), if any. */
export function linkAt(inline: Inline, offset: number): { href: string; from: number; to: number } | null {
  const span = spanAt(inline, offset) ?? (offset > 0 ? spanAt(inline, offset - 1) : undefined);
  if (!span?.link) return null;
  const href = span.link;
  // The contiguous run of spans with this link around the offset.
  let pos = 0;
  const runs: { from: number; to: number }[] = [];
  for (const s of inline) {
    const end = pos + s.text.length;
    if (s.link === href) {
      const last = runs[runs.length - 1];
      if (last && last.to === pos) last.to = end;
      else runs.push({ from: pos, to: end });
    }
    pos = end;
  }
  const run = runs.find((r) => offset >= r.from && offset <= r.to);
  return run ? { href, from: run.from, to: run.to } : null;
}

// ---------------------------------------------------------------------------
// Doc helpers

export function blockIndex(doc: Doc, id: string): number {
  return doc.blocks.findIndex((b) => b.id === id);
}

export function getBlock(doc: Doc, id: string): Block {
  const block = doc.blocks.find((b) => b.id === id);
  if (!block) throw new Error(`Unknown block ${id}`);
  return block;
}

export function sameCell(a?: Cell, b?: Cell): boolean {
  return a?.row === b?.row && a?.col === b?.col;
}

export function samePosition(a: Position, b: Position): boolean {
  return a.blockId === b.blockId && a.offset === b.offset && sameCell(a.cell, b.cell);
}

/** Negative if a is before b in document order, 0 if equal, positive if after. */
export function comparePositions(doc: Doc, a: Position, b: Position): number {
  if (a.blockId !== b.blockId) return blockIndex(doc, a.blockId) - blockIndex(doc, b.blockId);
  if (a.cell && b.cell && !sameCell(a.cell, b.cell)) {
    return a.cell.row - b.cell.row || a.cell.col - b.cell.col;
  }
  return a.offset - b.offset;
}

export function isCollapsed(sel: Selection): boolean {
  return samePosition(sel.anchor, sel.focus);
}

/** Selection endpoints in document order. */
export function orderedRange(doc: Doc, sel: Selection): { from: Position; to: Position } {
  return comparePositions(doc, sel.anchor, sel.focus) <= 0
    ? { from: sel.anchor, to: sel.focus }
    : { from: sel.focus, to: sel.anchor };
}

export function caret(blockId: string, offset: number, cell?: Cell): Selection {
  const p: Position = cell ? { blockId, offset, cell } : { blockId, offset };
  return { anchor: p, focus: p };
}

/** The first caret position inside a block. */
export function startOf(block: Block): Position {
  return block.type === 'table' ? { blockId: block.id, offset: 0, cell: { row: 0, col: 0 } } : { blockId: block.id, offset: 0 };
}

/** The last caret position inside a block. */
export function endOf(block: Block): Position {
  if (block.type === 'table') {
    const row = block.rows.length - 1;
    const col = block.align.length - 1;
    return { blockId: block.id, offset: inlineLength(block.rows[row]![col]!), cell: { row, col } };
  }
  if (block.type === 'divider') return { blockId: block.id, offset: 0 };
  return { blockId: block.id, offset: inlineLength(block.content) };
}

/** Moves positions that point past the end of their container back inside it, and positions in removed blocks to the start. */
export function clampSelection(doc: Doc, sel: Selection): Selection {
  const clamp = (p: Position): Position => {
    const block = doc.blocks.find((b) => b.id === p.blockId);
    if (!block) return startOf(doc.blocks[0]!);
    const content = containerContent(block, p.cell);
    return { ...p, offset: Math.min(p.offset, content ? inlineLength(content) : 0) };
  };
  return { anchor: clamp(sel.anchor), focus: clamp(sel.focus) };
}

export function createState(doc: Doc): EditorState {
  const blocks = doc.blocks.length > 0 ? doc.blocks : [paragraph()];
  const first = blocks.find(isTextBlock) ?? blocks[0]!;
  const start = startOf(first);
  return { doc: { blocks }, selection: { anchor: start, focus: start }, storedMarks: null };
}
