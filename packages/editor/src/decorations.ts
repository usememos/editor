// Decorations: CSS classes on ranges of text, computed from a block's text
// and never saved. Use them to highlight #tags or @mentions, for example.

import { type Block, type Cell, type Inline, type Span, inlineText } from './model';

export interface Decoration {
  /** Start offset in the container's text. */
  readonly from: number;
  /** End offset (exclusive). */
  readonly to: number;
  readonly class: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface TextRange {
  readonly from: number;
  readonly to: number;
}

/** One text container: a block's content, or one table cell. */
export interface DecorationContext {
  readonly block: Block;
  /** Set for a table cell. */
  readonly cell?: Cell;
  /** The container's plain text. An image counts as one character. */
  readonly text: string;
  readonly content: Inline;
  /** Ranges of inline code, links, images, raw HTML and extension tokens, which decorators usually skip. */
  readonly excluded: readonly TextRange[];
}

export type Decorator = (ctx: DecorationContext) => readonly Decoration[];

/** Ranges of spans that are code, links, images, raw HTML or tokens, merged where they touch. */
function excludedRanges(content: Inline): TextRange[] {
  const out: { from: number; to: number }[] = [];
  let pos = 0;
  for (const span of content) {
    const end = pos + span.text.length;
    if (isExcluded(span)) {
      const last = out[out.length - 1];
      if (last && last.to === pos) last.to = end;
      else out.push({ from: pos, to: end });
    }
    pos = end;
  }
  return out;
}

/** Whether a span is code, a link, an image, raw HTML or a token: text that is not plain prose. */
export function isExcluded(span: Span): boolean {
  return !!span.link || !!span.image || !!span.token || span.marks.includes('code') || span.marks.includes('html');
}

export function decorationContext(block: Block, content: Inline, cell?: Cell): DecorationContext {
  return { block, cell, content, text: inlineText(content), excluded: excludedRanges(content) };
}

/** Whether `[from, to)` overlaps any of `ranges`, which are sorted and do not overlap each other (as `excluded` is). */
export function overlapsAny(from: number, to: number, ranges: readonly TextRange[]): boolean {
  // The first range that ends after `from` is the only one that can overlap.
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid]!.to <= from) lo = mid + 1;
    else hi = mid;
  }
  const r = ranges[lo];
  return r !== undefined && to > r.from;
}

/** Whether two decorations are the same: range, class and attributes. */
export function sameDecoration(a: Decoration, b: Decoration): boolean {
  return a.from === b.from && a.to === b.to && a.class === b.class && sameAttributes(a.attributes, b.attributes);
}

/** Whether two lists hold the same decorations in the same order. */
export function sameDecorations(a: readonly Decoration[], b: readonly Decoration[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameDecoration(a[i]!, b[i]!)) return false;
  return true;
}

function sameAttributes(a: Decoration['attributes'], b: Decoration['attributes']): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * Splits content at decoration edges. Each piece is a span with the
 * decorations that cover it, in the order given. Spans for which `atomic`
 * returns true (given their start offset) are never split, and their pieces
 * are marked `atomic`.
 */
export function splitByDecorations(
  content: Inline,
  decorations: readonly Decoration[],
  atomic?: (span: Span, from: number) => boolean,
): { span: Span; decorations: Decoration[]; atomic: boolean }[] {
  const valid = decorations.filter((d) => d.to > d.from);
  if (valid.length === 0) {
    let pos = 0;
    return content.map((span) => {
      const piece = { span, decorations: [], atomic: !!atomic?.(span, pos) };
      pos += span.text.length;
      return piece;
    });
  }
  const cuts = [...new Set(valid.flatMap((d) => [d.from, d.to]))].sort((a, b) => a - b);
  // Pieces come in text order, so the decorations covering one are found by a
  // sweep: those started by its start and not ended, kept in the order given.
  const byStart = valid.map((d, index) => ({ d, index })).sort((a, b) => a.d.from - b.d.from);
  let next = 0;
  const active: { d: Decoration; index: number }[] = [];
  const covering = (start: number, end: number): Decoration[] => {
    while (next < byStart.length && byStart[next]!.d.from <= start) active.push(byStart[next++]!);
    for (let k = active.length - 1; k >= 0; k--) if (active[k]!.d.to <= start) active.splice(k, 1);
    // A decoration covers an atomic span only if it covers all of it.
    return active
      .filter((e) => e.d.to >= end)
      .sort((a, b) => a.index - b.index)
      .map((e) => e.d);
  };
  const out: { span: Span; decorations: Decoration[]; atomic: boolean }[] = [];
  let pos = 0;
  for (const span of content) {
    const end = pos + span.text.length;
    const whole = !!atomic?.(span, pos);
    // An image is one character and is never split; neither is an atomic span.
    const points = span.image || whole ? [] : cuts.slice(firstAbove(cuts, pos), firstAbove(cuts, end - 1));
    let start = pos;
    for (const cut of [...points, end]) {
      const piece = start === pos && cut === end ? span : { ...span, text: span.text.slice(start - pos, cut - pos) };
      out.push({ span: piece, decorations: covering(start, cut), atomic: whole });
      start = cut;
    }
    pos = end;
  }
  return out;
}

/** The index of the first value above `x` in a sorted array. */
function firstAbove(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
