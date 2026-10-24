// Source mode highlighting: decorations over the source block's text from the
// Markdown markup the parser read in it (see markdown/markup.ts), the text as
// spans split at syntax so decorators and the suggestion controller see the
// prose runs rich mode gives them, and the decorations moved through an edit
// while the exact ones are computed.

import { type Decoration, type Decorator, decorationContext, sameDecorations } from './decorations';
import type { Extension } from './extension';
import type { CodeBlock, Inline, Span } from './model';
import { type Markup, type MarkupKind, markdownMarkup } from './markdown/markup';
import type { MarkdownOptions } from './markdown/options';
import { inlineText } from './model';
import { changedRange } from './sourceMode';

/** The built-in class per kind of markup. */
const SOURCE_CLASSES: Readonly<Record<MarkupKind, string>> = {
  marker: 'mbe-src-marker',
  heading: 'mbe-src-heading',
  em: 'mbe-src-em',
  strong: 'mbe-src-strong',
  strike: 'mbe-src-strike',
  code: 'mbe-src-code',
  link: 'mbe-src-link',
  url: 'mbe-src-url',
  html: 'mbe-src-html',
  token: 'mbe-src-token',
  escape: 'mbe-src-escape',
  lang: 'mbe-src-lang',
};

/** The kinds that are not prose: a decorator looking for tags or mentions skips them, as rich mode skips code, links and tokens. */
const EXCLUDED_KINDS: ReadonlySet<MarkupKind> = new Set<MarkupKind>(['marker', 'code', 'url', 'html', 'token', 'escape', 'lang']);

/** Up to this many characters, the decorations are computed on every keystroke; above, a keystroke shows the last ones moved through its edit, and the exact ones follow. */
export const SYNC_LIMIT = 20_000;
/** An edit replacing more than this is a paste or a load, not typing: the decorations are computed at once. */
const SHIFT_LIMIT = 1000;
/** How long after the last keystroke the exact decorations are computed, so fast typing does not parse the text on every key. */
const SETTLE_MS = 80;

/** What makes up the decorations of source mode's block. */
export interface SourceDecorationConfig {
  /** The built-in highlighting (`sourceHighlighting`). */
  readonly highlight: boolean;
  /** The theme's class per kind of markup. */
  readonly classes?: Readonly<Partial<Record<MarkupKind, string>>>;
  /** The extensions' decorators, run over the text split at its syntax. */
  readonly decorators: readonly Decorator[];
  /** The extensions' code decorators, run over the code of each fence. */
  readonly codeDecorators: readonly NonNullable<Extension['codeDecorations']>[];
}

/**
 * The decorations of source mode's block: the Markdown's own highlighting,
 * then the decorators over the text split at its syntax, and the code
 * decorators over each code block in it, their offsets moved and clipped to
 * the code.
 */
export function sourceDecorations(block: CodeBlock, text: string, markup: Markup, config: SourceDecorationConfig): Decoration[] {
  const out: Decoration[] = config.highlight ? highlightDecorations(markup, config.classes) : [];
  if (config.decorators.length > 0) {
    const ctx = decorationContext(block, sourceInline(text, markup));
    for (const fn of config.decorators) out.push(...fn(ctx));
  }
  if (config.codeDecorators.length > 0) {
    for (const code of markup.code) {
      const ctx = { block, text: text.slice(code.from, code.to), language: code.language };
      for (const d of config.codeDecorators.flatMap((fn) => fn(ctx))) {
        const from = code.from + Math.max(0, d.from);
        const to = code.from + Math.min(code.to - code.from, d.to);
        if (to > from) out.push({ ...d, from, to });
      }
    }
  }
  return out;
}

/**
 * Source mode's decorations for one editor, computed once per text.
 * Computing them parses the whole text and runs every decorator over it,
 * about a quarter of a frame per 100 KB, so in a long text a keystroke gets
 * the previous decorations moved through its edit (right where nothing
 * changed; the edited range follows) and the exact ones are computed once
 * typing pauses, when `onReady` has the block rendered again if they differ.
 */
export class SourceHighlighter {
  private last: { text: string; decorations: Decoration[] } | null = null;
  private markupFor: { text: string; markup: Markup } | null = null;
  private spansFor: { text: string; markup: Markup; spans: Inline } | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: MarkdownOptions | undefined,
    private readonly config: () => SourceDecorationConfig,
    private readonly onReady: () => void,
  ) {}

  /** The markup of the text, read once per text: the decorations and autocomplete share it. */
  markup(text: string): Markup {
    if (this.markupFor?.text !== text) this.markupFor = { text, markup: markdownMarkup(text, this.options) };
    return this.markupFor.markup;
  }

  /**
   * The text as spans split at its syntax (`sourceInline`), for the
   * suggestion controller, once per text. In a long text being typed in, the
   * last markup read is moved through the edit, as the decorations are, so
   * the popup's check costs no parse on a keystroke.
   */
  spans(text: string): Inline {
    const exact = this.markupFor?.text === text ? this.markupFor.markup : null;
    // Spans built from moved markup are made again once the exact markup is read.
    if (this.spansFor?.text === text && (!exact || this.spansFor.markup === exact)) return this.spansFor.spans;
    let markup = exact;
    if (!markup && this.markupFor && text.length > SYNC_LIMIT) {
      const ranges = shiftRanges(this.markupFor.markup.ranges, this.markupFor.text, text);
      if (ranges) markup = { ranges, code: this.markupFor.markup.code };
    }
    markup ??= this.markup(text);
    const spans = sourceInline(text, markup);
    this.spansFor = { text, markup, spans };
    return spans;
  }

  decorations(block: CodeBlock): Decoration[] {
    const text = inlineText(block.content);
    const last = this.last;
    if (last && last.text === text) return last.decorations;
    if (last && text.length > SYNC_LIMIT) {
      const shifted = shiftRanges(last.decorations, last.text, text);
      if (shifted) {
        this.last = { text, decorations: shifted };
        this.schedule(block);
        return shifted;
      }
    }
    return this.read(block, text);
  }

  /** Forgets the decorations, for when what they depend on changed (`redecorate`). */
  reset(): void {
    this.last = null;
  }

  destroy(): void {
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null;
  }

  private read(block: CodeBlock, text: string): Decoration[] {
    this.destroy();
    const decorations = sourceDecorations(block, text, this.markup(text), this.config());
    this.last = { text, decorations };
    return decorations;
  }

  private schedule(block: CodeBlock): void {
    this.destroy();
    this.pending = setTimeout(() => {
      this.pending = null;
      const last = this.last;
      if (!last) return;
      const exact = this.read(block, last.text);
      // Typing inside a word changes nothing: the shifted decorations were already right.
      if (!sameDecorations(last.decorations, exact)) this.onReady();
    }, SETTLE_MS);
  }
}

/**
 * Ranges over `before` moved through the one edit that made `after`: ranges
 * before the edit stay, ranges after it move by the edit's length change, a
 * range around it grows or shrinks with it, and ranges inside it go. Null
 * when the edit is too large for that to be worth it.
 */
export function shiftRanges<T extends { readonly from: number; readonly to: number }>(ranges: readonly T[], before: string, after: string): T[] | null {
  const { from: p, toBefore: oldEnd, toAfter: newEnd } = changedRange(before, after);
  if (oldEnd - p > SHIFT_LIMIT || newEnd - p > SHIFT_LIMIT) return null;
  const delta = after.length - before.length;
  const out: T[] = [];
  for (const r of ranges) {
    const from = r.from < p ? r.from : r.from >= oldEnd ? r.from + delta : p;
    const to = r.to <= p ? r.to : r.to >= oldEnd ? r.to + delta : p;
    if (to > from) out.push(from === r.from && to === r.to ? r : { ...r, from, to });
  }
  return out;
}

/** The highlighting decorations: the built-in class per kind, and the theme's class for it. */
export function highlightDecorations(markup: Markup, classes?: Readonly<Partial<Record<MarkupKind, string>>>): Decoration[] {
  return markup.ranges.map((r) => {
    const themed = classes?.[r.kind];
    return { from: r.from, to: r.to, class: themed ? `${SOURCE_CLASSES[r.kind]} ${themed}` : SOURCE_CLASSES[r.kind] };
  });
}

const EXCLUDED: Span['marks'] = ['code'];
const PROSE: Span['marks'] = [];

/**
 * The source text as spans split at its syntax: markup, code, URLs, raw
 * HTML, tokens and escapes are spans a decorator skips (`isExcluded`), and
 * the prose between them plain spans, so `tags()` and `mentions()` see the
 * same runs as in rich mode.
 */
export function sourceInline(text: string, markup: Markup): Inline {
  const out: Span[] = [];
  const span = (a: number, b: number, marks: Span['marks']) => {
    if (b > a) out.push({ text: text.slice(a, b), marks });
  };
  // The excluded run being built: ranges that touch or overlap join it.
  let from = 0;
  let to = 0;
  for (const r of markup.ranges) {
    if (!EXCLUDED_KINDS.has(r.kind)) continue;
    if (r.from > to) {
      span(from, to, EXCLUDED);
      span(to, r.from, PROSE);
      from = r.from;
    }
    to = Math.max(to, r.to);
  }
  span(from, to, EXCLUDED);
  span(to, text.length, PROSE);
  return out;
}
