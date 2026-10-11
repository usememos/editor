// Document model.
//
// A document is a flat, ordered list of blocks. Blocks are immutable: every
// edit produces new block objects for the blocks it touches and reuses the
// rest. The view relies on this to re-render only blocks whose object
// identity changed, and history relies on it to keep snapshots cheap.

export type Mark = 'bold' | 'italic' | 'strike' | 'code';

/** Canonical mark order. Used for sorting and for nesting when rendering. */
export const MARK_ORDER: readonly Mark[] = ['bold', 'italic', 'strike', 'code'];

/** A run of text that shares one set of marks. */
export interface Span {
  readonly text: string;
  /** Sorted by MARK_ORDER, no duplicates. */
  readonly marks: readonly Mark[];
}

/** Inline content: normalized spans (no empty spans, no adjacent equal marks). */
export type Inline = readonly Span[];

export interface ParagraphBlock {
  readonly id: string;
  readonly type: 'paragraph';
  readonly content: Inline;
}

export interface HeadingBlock {
  readonly id: string;
  readonly type: 'heading';
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly content: Inline;
}

/** Blocks covered by the prototype. Step 3 adds lists, quote, code, table, divider. */
export type Block = ParagraphBlock | HeadingBlock;

export interface Doc {
  readonly blocks: readonly Block[];
}

/** A caret position: a character offset into a block's plain text. */
export interface Position {
  readonly blockId: string;
  readonly offset: number;
}

export interface Selection {
  readonly anchor: Position;
  readonly focus: Position;
}

export interface EditorState {
  readonly doc: Doc;
  readonly selection: Selection;
  /** Marks to apply to the next typed text, set by toggling a mark on a collapsed selection. */
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

export function heading(level: HeadingBlock['level'], content: Inline = [], id = createId()): HeadingBlock {
  return { id, type: 'heading', level, content: normalizeInline(content) };
}

export function withContent<B extends Block>(block: B, content: Inline): B {
  return { ...block, content: normalizeInline(content) };
}

// ---------------------------------------------------------------------------
// Marks

export function sortMarks(marks: Iterable<Mark>): Mark[] {
  const set = new Set(marks);
  return MARK_ORDER.filter((m) => set.has(m));
}

export function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
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
    if (prev && sameMarks(prev.marks, span.marks)) {
      out[out.length - 1] = { text: prev.text + span.text, marks: prev.marks };
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
    if (a < b) out.push({ text: span.text.slice(a - pos, b - pos), marks: span.marks });
    pos = end;
  }
  return out;
}

export function concatInline(...parts: Inline[]): Span[] {
  return normalizeInline(parts.flat());
}

/** Marks a character typed at `offset` should get: those of the character before it, or after it at offset 0. */
export function marksAt(inline: Inline, offset: number): readonly Mark[] {
  let pos = 0;
  for (const span of inline) {
    const end = pos + span.text.length;
    if (offset > pos && offset <= end) return span.marks;
    if (offset === 0 && pos === 0) return span.marks;
    pos = end;
  }
  return [];
}

export function insertInline(inline: Inline, offset: number, text: string, marks: readonly Mark[]): Span[] {
  return concatInline(sliceInline(inline, 0, offset), [{ text, marks }], sliceInline(inline, offset));
}

export function deleteInline(inline: Inline, from: number, to: number): Span[] {
  return concatInline(sliceInline(inline, 0, from), sliceInline(inline, to));
}

/** True if every character in [from, to) carries `mark`. */
export function rangeHasMark(inline: Inline, from: number, to: number, mark: Mark): boolean {
  const slice = sliceInline(inline, from, to);
  return slice.length > 0 && slice.every((s) => s.marks.includes(mark));
}

export function setMarkInRange(inline: Inline, from: number, to: number, mark: Mark, on: boolean): Span[] {
  const middle = sliceInline(inline, from, to).map((s) => ({
    text: s.text,
    marks: on ? sortMarks([...s.marks, mark]) : s.marks.filter((m) => m !== mark),
  }));
  return concatInline(sliceInline(inline, 0, from), middle, sliceInline(inline, to));
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

/** Negative if a is before b in document order, 0 if equal, positive if after. */
export function comparePositions(doc: Doc, a: Position, b: Position): number {
  if (a.blockId === b.blockId) return a.offset - b.offset;
  return blockIndex(doc, a.blockId) - blockIndex(doc, b.blockId);
}

export function isCollapsed(sel: Selection): boolean {
  return sel.anchor.blockId === sel.focus.blockId && sel.anchor.offset === sel.focus.offset;
}

/** Selection endpoints in document order. */
export function orderedRange(doc: Doc, sel: Selection): { from: Position; to: Position } {
  return comparePositions(doc, sel.anchor, sel.focus) <= 0
    ? { from: sel.anchor, to: sel.focus }
    : { from: sel.focus, to: sel.anchor };
}

export function caret(blockId: string, offset: number): Selection {
  const p = { blockId, offset };
  return { anchor: p, focus: p };
}

export function createState(doc: Doc): EditorState {
  const blocks = doc.blocks.length > 0 ? doc.blocks : [paragraph()];
  const first = blocks[0]!;
  return { doc: { blocks }, selection: caret(first.id, 0), storedMarks: null };
}
