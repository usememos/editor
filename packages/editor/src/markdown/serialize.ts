// Markdown serializer: document model → Markdown.
//
// Output is normalized, not a copy of the original source:
//
// - `**bold**`, `*italic*`, `~~strike~~`, code spans with a fence longer than
//   any backtick run inside, `[text](url)`, `<url>` autolinks, `![alt](src)`.
// - ATX headings, `-` bullets, ordered items numbered from the list's start,
//   `- [ ]` / `- [x]` tasks, nested items indented to the parent's content
//   column, backtick-fenced code, `---` dividers, GFM tables.
// - One blank line between blocks, except between list items (tight lists).
//   Adjacent quote blocks and quoted list items with the same callout are
//   one blockquote: its blocks are written the same way, then every line is
//   prefixed with `> ` (a `>` line between paragraphs).
// - Hard line breaks are a backslash at the end of the line. Where Markdown
//   has no line breaks (headings, table cells), "\n" is written as `&#10;`.
// - An empty paragraph is written as `&nbsp;`, a paragraph holding only a
//   no-break space, which renders as an empty line and reads back as an
//   empty paragraph. Empty paragraphs at the end of the document are
//   dropped. An empty quote is written as `> &nbsp;` the same way.
// - A callout is a blockquote whose first line is a GitHub alert marker, such
//   as `> [!NOTE]`. Quotes with different callouts are separate blockquotes.
// - A collapsible section is `<details>` and `<summary>title</summary>`, its
//   body, and `</details>`, each part with a blank line around it, so the
//   body is Markdown.
//
// Text is escaped so that it reads back as the same content, escaping only
// what could change meaning. The invariant, checked by the tests for every
// spec example, is save stability: serialize(parse(md)) is a fixed point.

import {
  type Block,
  type Doc,
  type ImageAtom,
  type Inline,
  type ListItemBlock,
  type Mark,
  MARK_ORDER,
  type Span,
  inlineText,
  normalizeInline,
  quoteKind,
  sameLink,
  sameQuote,
  unquote,
  sameMarks,
  setMarkInRange,
  deleteInline,
} from '../model';
import { imageSuffix, imageSuffixText } from './ast';
import { interruptsParagraph } from './blocks';
import { AUTOLINK_EMAIL, AUTOLINK_URI, isUnicodePunctuation, isUnicodeWhitespace, parseInline } from './inline';
import { emailLiterals, isLiteralBoundary, literalHref, urlLiteralAt } from './autolink';
import { type InlineSyntax, type MarkdownOptions, type ResolvedMarkdown, resolveMarkdown } from './options';
import { type MarkdownSource, saveWithSource } from './source';

export function serializeMarkdown(doc: Doc, options: SerializeOptions = {}): string {
  if (options.source) return saveWithSource(doc.blocks, options.source, options);
  // Empty lines at the end render as nothing, so they are not written.
  let end = doc.blocks.length;
  while (end > 0 && isEmptyParagraph(doc.blocks[end - 1]!)) end--;
  const out = serializeBlocks(doc.blocks.slice(0, end), options);
  return out ? out + '\n' : '';
}

export interface SerializeOptions extends MarkdownOptions {
  /**
   * The source the document was loaded from (see `loadMarkdown`). Blocks
   * that are unchanged since loading are written exactly as they were.
   */
  readonly source?: MarkdownSource | null;
}

/** Blocks as Markdown, without a final line ending. */
export function serializeBlocks(blocks: readonly Block[], options?: MarkdownOptions): string {
  const ctx = contexts(options);
  let out = '';
  let prev: Block | null = null;
  const lists = new ListState(ctx.paragraph);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    let text: string;
    let separator = '\n\n';
    const kind = quoteKind(block);
    if (kind) {
      // Adjacent quotes and quoted list items of the same kind are one
      // blockquote: its blocks written as they are inside it, then quoted.
      let end = i + 1;
      while (end < blocks.length && sameQuote(block, blocks[end])) end++;
      const inner = blocks.slice(i, end).map(unquote);
      let body = serializeBlocks(inner, options);
      // A list that cannot interrupt a paragraph needs a blank line after the marker.
      if (kind !== 'quote') body = `[!${kind.toUpperCase()}]\n${interrupts(inner[0]!) ? '' : '\n'}${body}`;
      if (out) out += separator;
      out += prefixLines(body, '> ', '>');
      prev = blocks[end - 1]!;
      i = end - 1;
      continue;
    }
    switch (block.type) {
      case 'paragraph':
        // Markdown has no empty paragraph.
        text = block.content.length === 0 ? '&nbsp;' : inlineToMarkdown(block.content, ctx.paragraph);
        break;
      case 'quote':
        // Handled above.
        continue;
      case 'heading':
        text = serializeHeading(block.level, block.content, ctx.heading);
        break;
      case 'listItem': {
        // A list in a quote ended at the quote.
        const before = prev?.type === 'listItem' && !prev.quote ? prev : null;
        const item = lists.next(block, before);
        text = item.text;
        if (before && !item.blankLineBefore) separator = '\n';
        break;
      }
      case 'code':
        text = serializeCode(block.language, inlineText(block.content));
        break;
      case 'raw':
        text = inlineText(block.content);
        break;
      case 'table':
        text = serializeTable(block.align, block.rows, ctx.cell);
        break;
      case 'divider':
        text = '---';
        break;
      case 'details': {
        // The title is HTML text, so only &, < and > need escaping.
        const title = inlineText(block.content).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
        text = `<details${block.open ? ' open' : ''}>\n<summary>${title}</summary>`;
        break;
      }
      case 'detailsEnd':
        text = '</details>';
        break;
    }
    if (out) out += separator;
    out += text;
    prev = block;
  }
  return out;
}

/** False for a list item that cannot start a list right after a paragraph line: an empty one, or numbered from other than 1. */
function interrupts(block: Block): boolean {
  if (block.type !== 'listItem') return true;
  if (block.listType === 'task') return true;
  return block.content.length > 0 && (block.start ?? 1) === 1;
}

export function isEmptyParagraph(block: Block): boolean {
  return block.type === 'paragraph' && block.content.length === 0;
}

function prefixLines(text: string, prefix: string, emptyPrefix: string): string {
  return text
    .split('\n')
    .map((line) => (line ? prefix + line : emptyPrefix))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Blocks

function serializeHeading(level: number, content: Inline, ctx: InlineContext): string {
  let text = inlineToMarkdown(content, ctx);
  // A trailing run of "#" would be read as the closing sequence.
  text = text.replace(/(^|[ \t])(#+)$/, (_m, sp: string, hashes: string) => `${sp}\\${hashes}`);
  return '#'.repeat(level) + (text ? ' ' + text : '');
}

function longestRun(text: string, ch: string): number {
  let longest = 0;
  let run = 0;
  for (const c of text) {
    run = c === ch ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

function serializeCode(language: string, text: string): string {
  // A backtick fence cannot have backticks in its info string; use tildes then.
  const ch = language.includes('`') ? '~' : '`';
  const fence = ch.repeat(Math.max(3, longestRun(text, ch) + 1));
  const info = escapeEntities(language.replace(/\\(?=[!-/:-@[-`{-~]|$)/g, '\\\\'));
  return `${fence}${info}\n${text ? text + '\n' : ''}${fence}`;
}

function serializeTable(align: readonly (string | null)[], rows: readonly (readonly Inline[])[], ctx: InlineContext): string {
  // Pipes are escaped everywhere in a row, even in code spans: GFM splits
  // cells before parsing inlines and turns `\|` back into `|`.
  const row = (cells: readonly Inline[]) =>
    '| ' + cells.map((cell) => inlineToMarkdown(representableCell(cell), ctx).replace(/\|/g, '\\|')).join(' | ') + ' |';
  const delimiter =
    '| ' +
    align.map((a) => (a === 'left' ? ':--' : a === 'center' ? ':-:' : a === 'right' ? '--:' : '---')).join(' | ') +
    ' |';
  const [header, ...body] = rows;
  return [row(header ?? align.map(() => [])), delimiter, ...body.map(row)].join('\n');
}

/**
 * Numbers and indents list items. Items at the same indent form one list
 * until a shallower item or a different kind of list (bullet or ordered)
 * comes. Tasks are bullets.
 */
class ListState {
  /** Per open nesting level: content column, list kind and last number. */
  private levels: { column: number; ordered: boolean; number: number }[] = [];

  constructor(private readonly ctx: InlineContext) {}

  /** `prev` is the list item right before this one, or null when this item starts a list. */
  next(item: ListItemBlock, prev: ListItemBlock | null): { text: string; blankLineBefore: boolean } {
    if (!prev) this.levels = [];
    const prevLevel = this.levels.length - 1;
    // An item cannot be nested more than one level below the previous one.
    const level = Math.min(item.indent, this.levels.length);
    const ordered = item.listType === 'ordered';
    const indent = level === 0 ? 0 : this.levels[level - 1]!.column;
    const same = this.levels[level];
    const number = ordered && same?.ordered ? same.number + 1 : (item.start ?? 1);

    const marker = ordered ? `${number}.` : '-';
    const column = indent + marker.length + 1;
    this.levels.length = level;
    this.levels.push({ column, ordered, number });

    let head = ' '.repeat(indent) + marker;
    if (item.listType === 'task') head += item.checked ? ' [x]' : ' [ ]';
    const lines = inlineToMarkdown(item.content, this.ctx).split('\n');
    const first = lines.shift()!;
    if (first) head += ' ' + first;
    const text = [head, ...lines.map((line) => (line ? ' '.repeat(column) + line : line))].join('\n');

    // A nested list right after the parent's text must be able to interrupt
    // that paragraph. Ordered lists not starting at 1 and empty items cannot,
    // so they get a blank line before them (which only makes the list loose).
    const prevHasText = prev !== null && (prev.content.length > 0 || prev.listType === 'task');
    const cannotInterrupt = (ordered && number !== 1) || (item.content.length === 0 && item.listType !== 'task');
    const blankLineBefore = level > prevLevel && prevHasText && cannotInterrupt;
    return { text, blankLineBefore };
  }
}

// ---------------------------------------------------------------------------
// Inline content

interface InlineContext {
  /** Escape block syntax at the start of each line (paragraph-like blocks). */
  readonly lineStart: boolean;
  /**
   * How "\n" is written: a hard line break (a backslash before the line
   * ending), a plain line ending (with the `breaks` option), or `&#10;` where
   * lines cannot break.
   */
  readonly newline: 'break' | 'soft' | 'entity';
  readonly options: ResolvedMarkdown;
}

function contexts(options: MarkdownOptions | undefined) {
  const o = resolveMarkdown(options);
  const inline = { lineStart: false, newline: 'entity', options: o } satisfies InlineContext;
  return {
    paragraph: { lineStart: true, newline: o.breaks ? 'soft' : 'break', options: o } satisfies InlineContext,
    // Headings and table cells are one line: a line break is written as a character reference.
    heading: inline,
    cell: inline,
  };
}

/** Serializes inline content as it appears in a paragraph. */
export function serializeInline(inline: Inline, options?: MarkdownOptions): string {
  return inlineToMarkdown(inline, contexts(options).paragraph);
}

type EmphasisMark = 'bold' | 'italic' | 'strike';
const EMPHASIS: readonly EmphasisMark[] = ['bold', 'italic', 'strike'];
const isEmphasis = (m: Mark): m is EmphasisMark => (EMPHASIS as readonly Mark[]).includes(m);

function inlineToMarkdown(inline: Inline, ctx: InlineContext): string {
  const spans = representableInline(inline);
  // Links that are GFM autolink literals are written bare, as typed, when the
  // output reads back the same; otherwise in angle brackets or as [text](url).
  if (ctx.options.autolinks && spans.some(isBareLink)) {
    for (const strategy of STRATEGIES) {
      const out = render(spans, ctx, strategy, true);
      if (sameInline(parseInline(out, ctx.options), spans)) return out;
    }
  }
  const first = render(spans, ctx, STRATEGIES[0]!);
  // Emphasis is the one place where the simple rules can fail: a delimiter
  // that can both open and close may pair with the wrong partner when marks
  // overlap. Check by parsing the output back, and if it does not give the
  // same content, try the other strategies.
  if (!spans.some((s) => s.marks.some(isEmphasis))) return first;
  if (sameInline(parseInline(first, ctx.options), spans)) return first;
  for (const strategy of STRATEGIES.slice(1)) {
    const out = render(spans, ctx, strategy);
    if (sameInline(parseInline(out, ctx.options), spans)) return out;
  }
  return first;
}

interface Strategy {
  /** Delimiter for italic. With "_", bold and italic delimiters can never pair with each other. */
  readonly italic: '*' | '_';
  /** Write every word character next to a delimiter run as an entity. */
  readonly encodeAll: boolean;
}

const STRATEGIES: readonly Strategy[] = [
  { italic: '*', encodeAll: false },
  { italic: '_', encodeAll: false },
  { italic: '_', encodeAll: true },
  { italic: '*', encodeAll: true },
];

function sameInline(a: Inline, b: Inline): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => {
      const t = b[i]!;
      return (
        s.text === t.text &&
        sameLink(s, t) &&
        sameMarks(s.marks, t.marks) &&
        s.image?.src === t.image?.src &&
        s.image?.alt === t.image?.alt &&
        s.image?.title === t.image?.title &&
        s.image?.align === t.image?.align &&
        s.image?.width === t.image?.width &&
        s.image?.height === t.image?.height
      );
    })
  );
}

const reSpecWhitespace = /^[\t\n\f\r\p{Zs}]+|[\t\n\f\r\p{Zs}]+$/gu;

/** A pipe after an odd number of backslashes. */
const ODD_BACKSLASH_PIPE = /(?<!\\)(?:\\\\)*\\\|/;

/**
 * A table cell's content as GFM can write it. GFM splits a row into cells
 * before it parses code spans, and a backslash escapes the character after it
 * there, so a pipe after an odd number of backslashes in a code span cannot be
 * written: `\\|` ends the cell, and `\\\|` reads back as two backslashes.
 * Such a pipe is written outside the code span, keeping its other marks.
 */
export function representableCell(inline: Inline): Inline {
  if (!inline.some((s) => s.marks.includes('code') && ODD_BACKSLASH_PIPE.test(s.text))) return inline;
  return normalizeInline(
    inline.flatMap((s): Span[] => {
      if (!s.marks.includes('code')) return [s];
      const marks = s.marks.filter((m) => m !== 'code');
      const out: Span[] = [];
      let from = 0;
      for (const m of s.text.matchAll(new RegExp(ODD_BACKSLASH_PIPE, 'g'))) {
        const pipe = m.index + m[0].length - 1;
        out.push({ ...s, text: s.text.slice(from, pipe) }, { ...s, text: '|', marks });
        from = pipe + 1;
      }
      out.push({ ...s, text: s.text.slice(from) });
      return out.filter((span) => span.text !== '');
    }),
  );
}

/**
 * The inline content as Markdown can represent it, which is what parsing the
 * serialized output gives back:
 * - Whitespace at the edges of a bold, italic or strike run moves outside it,
 *   because `**foo **` is not valid emphasis. Whitespace in a code span
 *   stays: the delimiter then sits next to the backtick, as in `` **` a`** ``.
 * - A "\n" in a code span is a hard break outside the code span.
 * - Spaces and tabs that start or end a line of text are dropped, because
 *   Markdown strips them. Writing them as character references instead would
 *   leave "&#32;" behind wherever someone typed a space first or last. A line
 *   of only whitespace keeps it, so the line is not lost.
 */
export function representableInline(inline: Inline): Span[] {
  let spans = normalizeInline(
    inline.flatMap((s): Span[] => {
      if (!s.marks.includes('code') || !s.text.includes('\n')) return [s];
      const marks = s.marks.filter((m) => m !== 'code');
      return s.text.split(/(\n)/).map((text) => (text === '\n' ? { ...s, text, marks } : { ...s, text }));
    }),
  );
  for (const mark of EMPHASIS) {
    const removals: [number, number][] = [];
    let pos = 0;
    let runStart = -1;
    let runText = '';
    const endRun = () => {
      if (runStart < 0) return;
      runText.replace(reSpecWhitespace, (ws: string, offset: number) => {
        removals.push([runStart + offset, runStart + offset + ws.length]);
        return ws;
      });
      runStart = -1;
      runText = '';
    };
    for (const span of spans) {
      if (span.marks.includes(mark)) {
        if (runStart < 0) runStart = pos;
        // Code is never at the edge for this, so it stands in as non-whitespace.
        runText += span.marks.includes('code') ? 'x'.repeat(span.text.length) : span.text;
      } else {
        endRun();
      }
      pos += span.text.length;
    }
    endRun();
    for (const [from, to] of removals) spans = setMarkInRange(spans, from, to, mark, false);
  }
  return dropLineEdgeSpaces(spans);
}

/** Text a line-end space can be dropped from: not code, raw HTML, a link, an image or an extension token. */
const isPlainSpan = (s: Span) => !s.link && !s.image && !s.token && !s.marks.includes('code') && !s.marks.includes('html');

function dropLineEdgeSpaces(spans: Span[]): Span[] {
  const text = spans.map((s) => s.text).join('');
  if (!/[ \t](\n|$)|(^|\n)[ \t]/.test(text)) return spans;
  // The span holding each character, to skip literal text.
  const plain: boolean[] = [];
  for (const s of spans) for (let i = 0; i < s.text.length; i++) plain.push(isPlainSpan(s));
  const removals: [number, number][] = [];
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text[i] !== '\n') continue;
    const space = (k: number) => (text[k] === ' ' || text[k] === '\t') && plain[k];
    let to = lineStart;
    while (to < i && space(to)) to++;
    let from = i;
    while (from > lineStart && space(from - 1)) from--;
    // A line of only whitespace keeps it.
    if (to < from) {
      if (to > lineStart) removals.push([lineStart, to]);
      if (from < i) removals.push([from, i]);
    }
    lineStart = i + 1;
  }
  let out: Span[] = spans;
  for (let k = removals.length - 1; k >= 0; k--) out = deleteInline(out, removals[k]![0], removals[k]![1]);
  return normalizeInline(out);
}

// -- Tokens -----------------------------------------------------------------

type Token =
  /** `inLink`: link text, where GFM does not look for autolink literals. */
  | { kind: 'text'; text: string; encodeFirst: boolean; encodeLast: boolean; inLink?: boolean }
  | { kind: 'delim'; ch: string; count: number; open: boolean }
  /** Output that is final: code spans, raw HTML, images, link syntax. */
  | { kind: 'raw'; text: string };

interface OpenMark {
  mark: EmphasisMark;
  ch: string;
  count: number;
}

function emphasisMarks(span: Span): EmphasisMark[] {
  return span.marks.filter(isEmphasis);
}

/** Builds the token list: text, delimiters for marks, and raw syntax. */
function tokenize(spans: readonly Span[], ctx: InlineContext, italic: '*' | '_', bare: boolean): Token[] {
  const tokens: Token[] = [];
  const stack: OpenMark[] = [];

  const closeTo = (depth: number) => {
    for (let k = stack.length - 1; k >= depth; k--) {
      tokens.push({ kind: 'delim', ch: stack[k]!.ch, count: stack[k]!.count, open: false });
    }
    stack.length = depth;
  };

  const runEnd = (mark: Mark, from: number, limit: number) => {
    let i = from;
    while (i < limit && spans[i]!.marks.includes(mark)) i++;
    return i;
  };

  const openMarks = (marks: readonly EmphasisMark[], index: number, limit: number) => {
    const toOpen = marks.filter((m) => !stack.some((o) => o.mark === m));
    // The mark that stays open longest goes outermost.
    toOpen.sort(
      (a, b) => runEnd(b, index, limit) - runEnd(a, index, limit) || MARK_ORDER.indexOf(a) - MARK_ORDER.indexOf(b),
    );
    for (const mark of toOpen) {
      let ch = mark === 'strike' ? '~' : mark === 'italic' ? italic : '*';
      // An opener right after a closer of the same character would merge
      // with it into one delimiter run; switch between "*" and "_".
      const last = tokens[tokens.length - 1];
      if (ch !== '~' && last?.kind === 'delim' && !last.open && last.ch === ch) ch = ch === '*' ? '_' : '*';
      const count = mark === 'italic' ? 1 : 2;
      tokens.push({ kind: 'delim', ch, count, open: true });
      stack.push({ mark, ch, count });
    }
  };

  /** Keeps the open marks from `base` up that are in `marks`, and closes the rest. */
  const closeExcept = (marks: readonly EmphasisMark[], base: number) => {
    let keep = base;
    while (keep < stack.length && marks.includes(stack[keep]!.mark)) keep++;
    closeTo(keep);
  };

  /** Closes marks the span does not have (above `base`) and opens the ones it adds. */
  const emitSpan = (span: Span, base: number, index: number, limit: number, inLink = false) => {
    const target = emphasisMarks(span);
    closeExcept(target, base);
    openMarks(target, index, limit);
    if (span.image) {
      tokens.push({ kind: 'raw', text: imageMarkdown(span.image, ctx) });
    } else if (span.marks.includes('html') || span.token) {
      tokens.push({ kind: 'raw', text: span.text });
    } else if (span.marks.includes('code')) {
      tokens.push({ kind: 'raw', text: codeSpan(span.text) });
    } else {
      tokens.push({ kind: 'text', text: span.text, encodeFirst: false, encodeLast: false, inLink });
    }
  };

  let i = 0;
  while (i < spans.length) {
    const span = spans[i]!;
    if (span.link === undefined) {
      emitSpan(span, 0, i, spans.length);
      i++;
      continue;
    }
    // A link: emphasis inside link text is separate from emphasis outside,
    // so only marks covering the whole link stay open across it.
    let j = i;
    while (j < spans.length && sameLink(spans[j]!, span)) j++;
    const common = EMPHASIS.filter((m) => spans.slice(i, j).every((s) => s.marks.includes(m)));
    closeExcept(common, 0);
    openMarks(common, i, spans.length);

    const auto = j === i + 1 ? (bare && isBareLink(span) ? span.text : autolink(span)) : null;
    if (auto) {
      tokens.push({ kind: 'raw', text: auto });
    } else {
      tokens.push({ kind: 'raw', text: '[' });
      const base = stack.length;
      for (let k = i; k < j; k++) emitSpan(spans[k]!, base, k, j, true);
      closeTo(base);
      tokens.push({ kind: 'raw', text: `](${linkDestination(span.link)}${linkTitle(span.linkTitle)})` });
    }
    i = j;
  }
  closeTo(0);
  return tokens;
}

// -- Delimiter flanking -----------------------------------------------------

type CharClass = 'space' | 'punct' | 'other';

function classify(ch: string | undefined): CharClass {
  if (ch === undefined || isUnicodeWhitespace(ch)) return 'space';
  return isUnicodePunctuation(ch) ? 'punct' : 'other';
}

function firstChar(s: string): string {
  return String.fromCodePoint(s.codePointAt(0)!);
}

function lastChar(s: string): string {
  const c = s.charCodeAt(s.length - 1);
  return c >= 0xdc00 && c <= 0xdfff && s.length > 1 ? s.slice(-2) : s.slice(-1);
}

/** The character a token starts (or ends) with in the output. */
function edgeChar(token: Token | undefined, end: 'first' | 'last'): string | undefined {
  if (!token) return undefined;
  if (token.kind === 'delim') return token.ch;
  if (token.kind === 'raw') return end === 'first' ? token.text[0] : token.text[token.text.length - 1];
  // Text: an entity-encoded character starts with "&" and ends with ";".
  if (end === 'first') return token.encodeFirst ? '&' : firstChar(token.text);
  return token.encodeLast ? ';' : lastChar(token.text);
}

/**
 * Checks every delimiter run against the CommonMark flanking rules and, where
 * a delimiter could not open or close, writes the neighbouring word character
 * as an entity: `a**"b"**c` becomes `&#97;**"b"**&#99;`, which parses as
 * intended because an entity counts as punctuation. Whitespace on the inner
 * side of a delimiter is encoded the same way. With `all`, every word
 * character next to a delimiter run is encoded, which also defeats the
 * "rule of three" (runs that can both open and close).
 */
function fixFlanking(tokens: Token[], all: boolean): void {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok.kind !== 'delim') {
      i++;
      continue;
    }
    let j = i;
    while (j < tokens.length) {
      const t = tokens[j]!;
      if (t.kind !== 'delim' || t.ch !== tok.ch) break;
      j++;
    }
    const before = tokens[i - 1];
    const after = tokens[j];
    const hasOpener = tokens.slice(i, j).some((t) => t.kind === 'delim' && t.open);
    const hasCloser = tokens.slice(i, j).some((t) => t.kind === 'delim' && !t.open);

    // A mark can be split into several delimiter pairs when it overlaps
    // other marks, so a delimiter may still sit next to whitespace inside its
    // run. Written as an entity, that whitespace counts as punctuation.
    if (hasOpener && after?.kind === 'text' && classify(edgeChar(after, 'first')) === 'space') after.encodeFirst = true;
    if (hasCloser && before?.kind === 'text' && classify(edgeChar(before, 'last')) === 'space') before.encodeLast = true;

    if (all) {
      if (before?.kind === 'text' && classify(edgeChar(before, 'last')) === 'other') before.encodeLast = true;
      if (after?.kind === 'text' && classify(edgeChar(after, 'first')) === 'other') after.encodeFirst = true;
    } else {
      let flank = flanking(tok.ch, edgeChar(before, 'last'), edgeChar(after, 'first'));
      if (hasOpener && !flank.canOpen && before?.kind === 'text') {
        before.encodeLast = true;
        flank = flanking(tok.ch, edgeChar(before, 'last'), edgeChar(after, 'first'));
      }
      if (hasCloser && !flank.canClose && after?.kind === 'text') after.encodeFirst = true;
    }
    i = j;
  }
}

function flanking(ch: string, before: string | undefined, after: string | undefined) {
  const b = classify(before);
  const a = classify(after);
  const left = a !== 'space' && (a !== 'punct' || b !== 'other');
  const right = b !== 'space' && (b !== 'punct' || a !== 'other');
  if (ch === '_') return { canOpen: left && (!right || b === 'punct'), canClose: right && (!left || a === 'punct') };
  return { canOpen: left, canClose: right };
}

// -- Rendering --------------------------------------------------------------

function render(spans: readonly Span[], ctx: InlineContext, strategy: Strategy, bare = false): string {
  const tokens = tokenize(spans, ctx, strategy.italic, bare);
  fixFlanking(tokens, strategy.encodeAll);
  // Pieces joined at the end, and the last character so far: reading the end
  // of a string built with += flattens it, which made long paragraphs quadratic.
  const out: string[] = [];
  let last: string | undefined;
  const write = (text: string) => {
    if (text === '') return;
    out.push(text);
    last = text[text.length - 1];
  };
  tokens.forEach((tok, i) => {
    if (tok.kind === 'delim') write(tok.ch.repeat(tok.count));
    else if (tok.kind === 'raw') {
      // Inline HTML such as a comment, first on a line after a line break, would start an HTML
      // block there. Four spaces keep the line in the paragraph: an indented line cannot start an
      // HTML block, indented code cannot interrupt a paragraph, and the spaces are stripped.
      if (ctx.lineStart && last === '\n' && interruptsParagraph(tok.text)) write('    ');
      write(tok.text);
    }
    else {
      write(
        escapeText(tok, ctx, {
          before: last,
          after: edgeChar(tokens[i + 1], 'first'),
          lineStart: last === undefined || last === '\n',
          atEnd: i === tokens.length - 1,
        }),
      );
    }
  });
  return out.join('');
}

const ALNUM = /[\p{L}\p{N}]/u;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const ENTITY_LIKE = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;

function entity(ch: string): string {
  return `&#${ch.codePointAt(0)!};`;
}

/**
 * Escapes a text token. `before` and `after` are the neighbouring output
 * characters; `lineStart` and `atEnd` tell whether the text starts a line
 * and ends the inline content.
 */
function escapeText(
  tok: { text: string; encodeFirst: boolean; encodeLast: boolean; inLink?: boolean },
  ctx: InlineContext,
  edges: { before: string | undefined; after: string | undefined; lineStart: boolean; atEnd: boolean },
): string {
  const lines = tok.text.split('\n');
  // What each "\n" becomes. A hard break cannot end a paragraph, so a final
  // "\n" is an entity; so is a "\n" next to a delimiter that needs one.
  const last = lines.length - 1;
  const breaks = lines.map((line, li) => {
    if (li === 0) return '';
    const entity =
      ctx.newline === 'entity' ||
      (li === last && line === '' && (edges.atEnd || tok.encodeLast)) ||
      (li === 1 && lines[0] === '' && tok.encodeFirst);
    if (entity) return '&#10;';
    // With `breaks`, a plain line ending is a line break. Not after an empty
    // line (that would be a blank line, which ends the paragraph), and not
    // after a space, which a soft break strips even when written as an entity.
    // Before the first "\n" of a token, the previous token may end with an entity (";").
    const fromEdge = li === 1 && lines[0] === '';
    const before = fromEdge ? (edges.lineStart ? '' : (edges.before ?? '')) : lines[li - 1]!;
    const plainBreak = ctx.newline === 'soft' && before !== '' && !(fromEdge ? /[ \t;]$/ : /[ \t]$/).test(before);
    return plainBreak ? '\n' : '\\\n';
  });
  let out = '';
  lines.forEach((line, li) => {
    const isFirst = li === 0;
    const isLast = li === lines.length - 1;
    out += breaks[li];
    const startsLine = !isFirst || edges.lineStart;
    const endsLine = !isLast || edges.atEnd;
    out += escapeLine(line, {
      before: isFirst ? edges.before : undefined,
      after: isLast ? edges.after : breaks[li + 1]![0],
      encodeFirst: isFirst && tok.encodeFirst,
      encodeLast: isLast && tok.encodeLast,
      startsLine,
      endsLine,
      blockSyntax: ctx.lineStart && startsLine,
      escape: ctx.options.escape,
      inline: ctx.options.inline,
      autolinks: ctx.options.autolinks && !tok.inLink,
    });
  });
  return out;
}

function escapeLine(
  line: string,
  o: {
    before: string | undefined;
    after: string | undefined;
    encodeFirst: boolean;
    encodeLast: boolean;
    startsLine: boolean;
    endsLine: boolean;
    blockSyntax: boolean;
    /** Characters syntax extensions need escaped. */
    escape?: string;
    /** Inline syntax extensions, some of which may read a backslash escape as a token. */
    inline?: readonly InlineSyntax[];
    /** GFM autolink literals are on: plain text that looks like a URL must not read back as a link. */
    autolinks?: boolean;
  },
): string {
  if (line === '') return '';
  // A backslash escape, or a character reference where an extension reads
  // the escape as its own token (`tags()` keeps `\#` as written).
  const bs = (ch: string) =>
    o.inline?.some((s) => s.triggers.includes('\\') && s.match('\\' + ch, 0) === 2) ? entity(ch) : '\\' + ch;
  // Characters written as entities: word characters next to delimiters, and
  // spaces or tabs at the start or end of a line (which Markdown strips).
  const lastIndex = line.length - lastChar(line).length;
  const encodeAt = new Set<number>();
  if (o.encodeFirst || (o.startsLine && (line[0] === ' ' || line[0] === '\t'))) encodeAt.add(0);
  if (o.encodeLast || (o.endsLine && (line[lastIndex] === ' ' || line[lastIndex] === '\t'))) encodeAt.add(lastIndex);
  const blockEscape = o.blockSyntax && !encodeAt.has(0) ? blockSyntaxEscapeIndex(line) : -1;
  const urlEscapes = o.autolinks ? literalEscapes(line, o.before, o.after) : null;

  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (encodeAt.has(i)) {
      const ch = i === lastIndex ? lastChar(line) : firstChar(line.slice(i));
      out += entity(ch);
      i += ch.length - 1;
      continue;
    }
    const ch = line[i]!;
    // Neighbours as written: an encoded character starts with "&" and ends with ";".
    const prev = i > 0 ? (encodeAt.has(i - 1) ? ';' : line[i - 1]) : o.before;
    const next = i < line.length - 1 ? (encodeAt.has(i + 1) ? '&' : line[i + 1]) : o.after;
    if (i === blockEscape || urlEscapes?.has(i)) {
      out += bs(ch);
      continue;
    }
    switch (ch) {
      case '\\':
        out += next === undefined || next === '\n' || ASCII_PUNCT.test(next) ? '\\\\' : ch;
        break;
      case '`':
      case '*':
      case '~':
      case '[':
      case ']':
        out += bs(ch);
        break;
      case '_': {
        // Intraword underscores (snake_case) cannot open or close emphasis.
        const intraword = prev !== undefined && next !== undefined && ALNUM.test(prev) && ALNUM.test(next);
        out += intraword ? ch : bs('_');
        break;
      }
      case '<':
        // Only "<" that could start a tag or an autolink.
        out += next === undefined || /[A-Za-z/!?]/.test(next) ? bs('<') : ch;
        break;
      case '&':
        out += ENTITY_LIKE.test(line.slice(i, i + 40)) ? bs('&') : ch;
        break;
      case '!':
        // "!" before a link would make it an image.
        out += next === '[' ? bs('!') : ch;
        break;
      default:
        out += o.escape && o.escape.includes(ch) ? bs(ch) : ch;
    }
  }
  return out;
}

/**
 * Indexes of characters to backslash-escape so that URLs and e-mail addresses
 * in plain text do not read back as autolink literals: the ":" of `https://`,
 * the "." of `www.` or the "@" of an address.
 */
function literalEscapes(line: string, before: string | undefined, after: string | undefined): Set<number> | null {
  const emails = emailLiterals(line);
  if (!emails.length && !/www\.|:\/\//i.test(line)) return null;
  const out = new Set<number>();
  // Read with the character after the line: `www.` then a line break is a link, at the end of the text it is not.
  const text = line + (after ?? '');
  for (const c of line.matchAll(/www\.|(?:https?|ftp):\/\//gi)) {
    const at = c.index!;
    const www = c[0].toLowerCase() === 'www.';
    if (!isLiteralBoundary(at > 0 ? line[at - 1] : before, www) || !urlLiteralAt(text, at)) continue;
    out.add(at + c[0].indexOf(www ? '.' : ':'));
  }
  for (const { from } of emails) out.add(line.indexOf('@', from));
  return out;
}

/**
 * Index of the character to backslash-escape so that a line does not start
 * a block (heading, quote, list item, thematic break, setext underline,
 * table delimiter row), or -1. Code fences, HTML and indented code are
 * already covered by the regular escapes and the leading-space entity.
 */
function blockSyntaxEscapeIndex(line: string): number {
  if (/^#{1,6}(?:[ \t]|$)/.test(line) || line[0] === '>') return 0;
  if (/^[-+](?:[ \t]|$)/.test(line) || /^-+[ \t]*$/.test(line) || /^(?:-[ \t]*){3,}$/.test(line)) return 0;
  if (/^=+[ \t]*$/.test(line)) return 0;
  const ordered = /^(\d{1,9})[.)](?:[ \t]|$)/.exec(line);
  if (ordered) return ordered[1]!.length;
  if (/^[|:\- \t]+$/.test(line) && line.includes('|') && line.includes('-')) return line.indexOf('-');
  return -1;
}

function codeSpan(text: string): string {
  const fence = '`'.repeat(longestRun(text, '`') + 1);
  // One space is stripped from each side when both are spaces, and a
  // backtick at the edge would merge with the fence: pad with a space.
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text));
  return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

// -- Links and images -------------------------------------------------------

const reAutolinkUri = new RegExp(`^${AUTOLINK_URI}$`);
const reEmail = new RegExp(`^${AUTOLINK_EMAIL}$`);

/** Whether a link span's text is a GFM autolink literal for its own destination. */
function isBareLink(span: Span): boolean {
  if (span.link === undefined || span.linkTitle !== undefined || span.image || span.token || span.marks.includes('code') || span.marks.includes('html')) return false;
  return literalHref(span.text) === span.link;
}

/** `<url>` when a link's text is its own URL (or e-mail address), else null. */
function autolink(span: Span): string | null {
  if (span.image || span.marks.includes('code') || span.marks.includes('html') || span.link === undefined || span.linkTitle !== undefined) return null;
  if (span.text === span.link && reAutolinkUri.test(span.link)) return `<${span.link}>`;
  if (span.link === 'mailto:' + span.text && reEmail.test(span.text)) return `<${span.text}>`;
  return null;
}

function escapeEntities(s: string): string {
  return s.replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
}

function linkDestination(url: string): string {
  if (url === '') return '<>';
  const balanced = (() => {
    let depth = 0;
    for (const c of url) {
      if (c === '(') depth++;
      else if (c === ')' && --depth < 0) return false;
    }
    return depth === 0;
  })();
  if (/[\x00-\x20<>\x7f]/.test(url) || !balanced) {
    return '<' + escapeEntities(url.replace(/[\\<>]/g, '\\$&')).replace(/\n/g, '%0A') + '>';
  }
  return escapeEntities(url.replace(/\\/g, '\\\\'));
}

/** ` "title"` after a link or image destination, or nothing. A blank line would end the paragraph, so it is dropped. */
function linkTitle(title: string | undefined): string {
  if (!title) return '';
  return ` "${escapeEntities(title.replace(/\n(?:[ \t]*\n)+/g, '\n').replace(/["\\]/g, '\\$&'))}"`;
}

function imageMarkdown(image: ImageAtom, ctx: InlineContext): string {
  // Alt text keeps line breaks as hard breaks: a soft break in alt text reads back as a space.
  const altCtx: InlineContext = ctx.newline === 'soft' ? { ...ctx, newline: 'break' } : ctx;
  const alt = escapeText({ text: image.alt, encodeFirst: false, encodeLast: false }, altCtx, {
    before: '[',
    after: ']',
    lineStart: false,
    atEnd: false,
  });
  const title = linkTitle(image.title);
  // The alignment and size go after the alt text, as in Obsidian. When alt
  // text would read back as part of them (it ends like `|center` or `|320`),
  // its last "|" is written as a character reference, which is not a "|".
  const suffix = imageSuffixText(image);
  const read = imageSuffix(alt + suffix);
  const same = read ? read.index === alt.length && imageSuffixText(read) === suffix : !suffix;
  const text = (same ? alt : alt.replace(/\|(?=[^|]*$)/, '&#124;')) + suffix;
  return `![${text}](${linkDestination(image.src)}${title})`;
}
