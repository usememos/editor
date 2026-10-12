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

export function overlapsAny(from: number, to: number, ranges: readonly TextRange[]): boolean {
  return ranges.some((r) => from < r.to && to > r.from);
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
  const cuts = new Set<number>();
  for (const d of valid) {
    cuts.add(d.from);
    cuts.add(d.to);
  }
  const out: { span: Span; decorations: Decoration[]; atomic: boolean }[] = [];
  let pos = 0;
  for (const span of content) {
    const end = pos + span.text.length;
    const whole = !!atomic?.(span, pos);
    // An image is one character and is never split; neither is an atomic span.
    const points = span.image || whole ? [] : [...cuts].filter((c) => c > pos && c < end).sort((a, b) => a - b);
    let start = pos;
    for (const cut of [...points, end]) {
      const piece = start === pos && cut === end ? span : { ...span, text: span.text.slice(start - pos, cut - pos) };
      // A decoration covers an atomic span only if it covers all of it.
      out.push({ span: piece, decorations: valid.filter((d) => d.from <= start && d.to >= cut), atomic: whole });
      start = cut;
    }
    pos = end;
  }
  return out;
}
