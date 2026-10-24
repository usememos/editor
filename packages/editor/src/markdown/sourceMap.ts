// Source maps: where a loaded block's text is in the Markdown it came from.
//
// Loading records, for each block that holds text, a list of segments: runs
// of the block's text (offsets into `inlineText(content)`) and the source
// range each was written in. A linear segment is text written as such, so
// an offset inside it maps one to one. An atomic segment stands for a source
// range as a whole: a soft line break with the next line's indentation, an
// escape or entity, an image, a tab the block's prefix consumed only partly,
// or a code span's line ending that became a space. The source between two
// segments is syntax. Source mode's caret mapping reads these.

import type { Block } from '../model';
import { type ContentSource, type InlineNode, type Range, pieceEnd } from './ast';

export interface Segment {
  /** Range in the block's text. */
  readonly from: number;
  readonly to: number;
  /** Range in the source text. */
  readonly srcFrom: number;
  readonly srcTo: number;
  /** True when the text was written as such, offset for offset. */
  readonly linear: boolean;
  /** For a line break: where its next line starts in the source. An offset from there maps after the break, not before it. */
  readonly nextLine?: number;
}

/** Where each 1-based line of a text starts, and where it ends before its line ending. A byte order mark is not on line 1. */
export interface LineTable {
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

export function lineTable(text: string): LineTable {
  const starts = [text.charCodeAt(0) === 0xfeff ? 1 : 0];
  const ends: number[] = [];
  const re = /\r\n|\n|\r/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    ends.push(m.index);
    starts.push(m.index + m[0].length);
  }
  ends.push(text.length);
  return { starts, ends };
}

/** What lowering needs to record source maps: the line table and, per block, the map. */
export interface LowerContext {
  readonly lines: LineTable;
  readonly maps: WeakMap<Block, readonly Segment[]>;
}

/** One segment: the text `[from, to)` is the source `[srcFrom, srcTo)`, written as such. */
export function identitySegment(from: number, to: number, srcFrom: number): Segment {
  return { from, to, srcFrom, srcTo: srcFrom + (to - from), linear: true };
}

/**
 * Builds the segments of one leaf block from the ranges of its inline nodes,
 * which count from the leaf content's start (see `ContentSource`).
 */
export class SegmentBuilder {
  readonly segments: Segment[] = [];
  /** How much of the block's text is recorded so far. */
  private at = 0;

  constructor(
    private readonly content: ContentSource,
    private readonly table: LineTable,
  ) {}

  /** Records where the next `length` characters of the block's text, lowered from `node`, were written. A node without a position (not from the parser) is syntax to the map. */
  record(node: InlineNode, length: number): void {
    const { pos } = node;
    const at = this.at;
    this.at += length;
    if (!pos) return;
    if (node.type === 'text' && node.pieces) {
      // Verbatim runs, with what is not written as such (escapes, entities) between them.
      let v = 0;
      let s = pos.from;
      for (const p of node.pieces) {
        if (p.at > v) this.atomic(at + v, at + p.at, s, p.from);
        this.linear(at + p.at, p.from, p.to);
        v = pieceEnd(p);
        s = p.to;
      }
      if (v < length) this.atomic(at + v, at + length, s, pos.to);
      return;
    }
    const written = node.type === 'code' ? node.content : node.type === 'text' || node.type === 'html' || node.type === 'token' ? pos : null;
    if (written && written.to - written.from === length) this.linear(at, written.from, written.to);
    // A line break with the next line's indentation, or an image.
    else this.atomic(at, at + length, pos.from, pos.to);
  }

  /** The text from `modelFrom` was written as the content's `[from, to)`: one segment per source line, the line endings and tab padding atomic. */
  linear(modelFrom: number, from: number, to: number): void {
    const { lines, start } = this.content;
    const { starts, ends } = this.table;
    let o = from + start;
    const end = to + start;
    let m = modelFrom;
    while (o < end) {
      const i = this.lineIndex(o);
      const line = lines[i];
      if (!line) return;
      const lineStart = starts[line.line - 1] ?? 0;
      const lineEnd = ends[line.line - 1] ?? lineStart;
      const d = o - line.at;
      if (d < line.pad) {
        // Spaces standing in for the rest of a tab.
        const n = Math.min(line.pad - d, end - o);
        this.push({ from: m, to: m + n, srcFrom: lineStart + line.offset - 1, srcTo: lineStart + line.offset, linear: false });
        o += n;
        m += n;
        continue;
      }
      const k = d - line.pad;
      const textLength = lineEnd - lineStart - line.offset;
      if (k < textLength) {
        const n = Math.min(textLength - k, end - o);
        this.push({ from: m, to: m + n, srcFrom: lineStart + line.offset + k, srcTo: lineStart + line.offset + k + n, linear: true });
        o += n;
        m += n;
        continue;
      }
      // The line ending, one character of the content.
      const nextStart = starts[line.line] ?? lineEnd;
      this.push({ from: m, to: m + 1, srcFrom: k === textLength ? lineEnd : nextStart, srcTo: nextStart, linear: false });
      o += 1;
      m += 1;
    }
  }

  /** The text `[modelFrom, modelTo)` stands for the content's `[from, to)` as a whole. */
  atomic(modelFrom: number, modelTo: number, from: number, to: number): void {
    const segment: Segment = { from: modelFrom, to: modelTo, srcFrom: this.source(from), srcTo: this.source(to), linear: false };
    // A line break: the next line's source start, before any prefix the block parser took off it.
    const { lines, start } = this.content;
    const last = this.lineIndex(to + start);
    const nextLine = last > this.lineIndex(from + start) ? this.table.starts[lines[last]!.line - 1] : undefined;
    this.push(nextLine === undefined ? segment : { ...segment, nextLine });
  }

  /** The source offset of a content offset: a line ending maps to the end of its line. */
  source(offset: number): number {
    const { lines, start } = this.content;
    const { starts, ends } = this.table;
    const o = offset + start;
    const line = lines[this.lineIndex(o)];
    if (!line) return 0;
    const lineStart = starts[line.line - 1] ?? 0;
    const lineEnd = ends[line.line - 1] ?? lineStart;
    const d = o - line.at;
    if (d < line.pad) return lineStart + line.offset - 1;
    const k = d - line.pad;
    const textLength = lineEnd - lineStart - line.offset;
    if (k <= textLength) return lineStart + line.offset + k;
    return starts[line.line] ?? lineEnd;
  }

  /** The index of the content line holding content offset `o`: the last one starting at or before it. */
  private lineIndex(o: number): number {
    const { lines } = this.content;
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid]!.at <= o) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private push(s: Segment): void {
    if (s.to <= s.from && s.srcTo <= s.srcFrom) return;
    const last = this.segments[this.segments.length - 1];
    // Linear segments that follow each other in both texts are one.
    if (last && last.linear && s.linear && last.to === s.from && last.srcTo === s.srcFrom) {
      this.segments[this.segments.length - 1] = { ...last, to: s.to, srcTo: s.srcTo };
      return;
    }
    this.segments.push(s);
  }
}

/** The last segment whose `key` is at or before `value`, or the first. */
function segmentAt(segments: readonly Segment[], key: 'from' | 'srcFrom', value: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid]![key] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The source offset for an offset in the block's text. Between two segments
 * (text whose nodes were made elsewhere than by the parser) the offset goes
 * to the next segment's source; at the end of a segment it stays before any
 * syntax that follows.
 */
export function toSource(segments: readonly Segment[], offset: number): number {
  if (segments.length === 0) return 0;
  const i = segmentAt(segments, 'from', offset);
  const s = segments[i]!;
  if (offset < s.from) return s.srcFrom;
  if (offset >= s.to) return offset === s.to || i === segments.length - 1 ? s.srcTo : segments[i + 1]!.srcFrom;
  return s.linear ? s.srcFrom + (offset - s.from) : s.srcFrom;
}

/**
 * The offset in the block's text for a source offset. On syntax, the offset
 * goes to the text after it; inside something atomic, before it.
 */
export function fromSource(segments: readonly Segment[], offset: number): number {
  if (segments.length === 0) return 0;
  const i = segmentAt(segments, 'srcFrom', offset);
  const s = segments[i]!;
  if (offset < s.srcFrom) return s.from;
  if (offset >= s.srcTo) return offset === s.srcTo || i === segments.length - 1 ? s.to : segments[i + 1]!.from;
  if (s.linear) return s.from + (offset - s.srcFrom);
  return s.nextLine !== undefined && offset >= s.nextLine ? s.to : s.from;
}

/** The source range the block's text covers, from its first segment to its last; null for a block with no map. */
export function sourceSpan(segments: readonly Segment[] | null | undefined): Range | null {
  if (!segments || segments.length === 0) return null;
  return { from: segments[0]!.srcFrom, to: segments[segments.length - 1]!.srcTo };
}
