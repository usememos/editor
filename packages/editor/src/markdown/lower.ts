// Lowering: Markdown syntax tree → the editor's flat document model.
//
// The model has no nesting (these rules are part of the product spec):
//
// - Soft line breaks become spaces (or "\n" with the `breaks` option); hard
//   line breaks become "\n".
// - Each list item becomes a `listItem` block whose `indent` is its nesting
//   depth. An ordered list keeps its start number on its first item. GFM
//   task items become `task` items.
// - In a block quote each paragraph becomes one `quote` block, and a
//   paragraph holding only a no-break space an empty one. Every other block
//   in it (a list, heading, code block, table, divider, HTML or extension
//   block) becomes its own blocks marked as quoted. A GitHub alert (first
//   line `[!NOTE]` and the like) sets `callout` on all of them. A quote
//   inside a quote, or a list the model cannot hold, becomes one quoted raw
//   Markdown block holding its source without the quote markers.
// - A top-level list the model cannot hold (see `fitsModel`) becomes one raw
//   Markdown block holding its source.
// - Links, images, code spans and raw HTML become span attributes and marks.
// - A top-level paragraph holding only a no-break space (`&nbsp;`) becomes an
//   empty paragraph: that is how the serializer writes empty lines.

import {
  ATOM_CHAR,
  type Block,
  CALLOUT_TYPES,
  type CalloutType,
  type ImageAtom,
  type ListType,
  type QuoteKind,
  type QuotableBlock,
  type Mark,
  MAX_INDENT,
  type Span,
  codeBlock,
  divider,
  heading,
  htmlBlock,
  listItem,
  normalizeInline,
  paragraph,
  quote,
  quoteKind,
  rawBlock,
  sortMarks,
  table,
  withQuote,
  withQuoteStart,
} from '../model';
import {
  type BlockNode,
  type BlockQuoteNode,
  type ContentSource,
  type ImageNode,
  type InlineNode,
  type ListItemNode,
  type ListNode,
  type SourceLines,
  imageSuffixText,
  inlineNodesText,
} from './ast';
import { DEFAULT_MARKDOWN, type MarkdownOptions } from './options';
import { type LineTable, type LowerContext, SegmentBuilder, lineTable } from './sourceMap';

/** The Markdown a tree was parsed from and its line table, for the source of what a quote holds that the model cannot. */
export interface SourceText {
  readonly text: string;
  readonly lines: LineTable;
  /** Called for each child of a quote as it is lowered, with the blocks it became (none for a callout's marker line). */
  readonly onQuoteChild?: (child: BlockNode, blocks: readonly Block[]) => void;
}

export function sourceText(text: string): SourceText {
  return { text, lines: lineTable(text) };
}

/**
 * Lowers one top-level block node. Structure the model cannot hold becomes
 * one raw Markdown block holding `source`, the node's Markdown. `before` is
 * the last block lowered before it.
 */
export function lowerTopLevel(node: BlockNode, options: MarkdownOptions, source: string, before?: Block, src?: SourceText): Block[] {
  return lowerIfFits(node, options, before, undefined, src) ?? [rawBlock('markdown', source)];
}

/**
 * Lowers one block node, or returns null when the model cannot hold its
 * structure (see `fitsModel`). With `ctx`, each block that holds text gets a
 * source map (see `sourceMap.ts`). With `src`, a quote always lowers: what
 * it holds that the model cannot becomes a quoted raw block of its source.
 */
export function lowerIfFits(node: BlockNode, options: MarkdownOptions, before?: Block, ctx?: LowerContext, src?: SourceText): Block[] | null {
  if (!fitsModel(node, 0, src !== undefined)) return null;
  const blocks: Block[] = [];
  lowerBlock(node, blocks, options, ctx, undefined, src);
  // A blockquote right after one of the same kind starts a new blockquote: a blank line was between them.
  const first = blocks[0];
  if (node.type === 'blockQuote' && first && quoteKind(first) !== null && quoteKind(before) === quoteKind(first)) {
    const started = withQuoteStart(first);
    blocks[0] = started;
    const map = ctx?.maps.get(first);
    if (map) ctx!.maps.set(started, map);
  }
  return blocks;
}

/**
 * True if lowering keeps the structure: a list item holds at most one
 * paragraph, first, followed only by nested lists no deeper than MAX_INDENT,
 * and a quote holds no quote and no list that breaks this, unless `raw`
 * says such a child can become a raw block of its source.
 */
function fitsModel(node: BlockNode, depth: number, raw = false): boolean {
  switch (node.type) {
    case 'blockQuote':
      return raw || node.children.every((child) => child.type !== 'blockQuote' && (child.type !== 'list' || fitsModel(child, 0)));
    case 'list':
      return (
        depth <= MAX_INDENT &&
        node.items.every((item) =>
          item.children.every(
            (child, i) => (child.type === 'paragraph' && i === 0) || (child.type === 'list' && fitsModel(child, depth + 1)),
          ),
        )
      );
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Inline content

/** With `map`, where each span's text was written is recorded as it is lowered. */
export function lowerInlines(nodes: readonly InlineNode[], options: MarkdownOptions = DEFAULT_MARKDOWN, map?: SegmentBuilder): Span[] {
  const out: Span[] = [];
  lowerInto(nodes, [], {}, out, options.breaks ? '\n' : ' ', map);
  return normalizeInline(out);
}

/** A content block's spans, and its source map when `ctx` and the leaf's source are known. */
function lowerContent(
  nodes: readonly InlineNode[],
  options: MarkdownOptions,
  source: ContentSource | undefined,
  ctx: LowerContext | undefined,
): { content: Span[]; map?: SegmentBuilder } {
  const map = ctx && source ? new SegmentBuilder(source, ctx.lines) : undefined;
  return { content: lowerInlines(nodes, options, map), map };
}

/** Records a lowered block's source map, when there is one, and returns the block. */
function mapped<T extends Block>(block: T, map: SegmentBuilder | undefined, ctx: LowerContext | undefined): T {
  if (map && ctx) ctx.maps.set(block, map.segments);
  return block;
}

/** A block whose text is its leaf's content as written: a code, HTML or extension block. */
function mappedText<T extends Block>(block: T, text: string, source: ContentSource | undefined, ctx: LowerContext | undefined): T {
  if (ctx && source) {
    const b = new SegmentBuilder(source, ctx.lines);
    b.linear(0, 0, text.length);
    ctx.maps.set(block, b.segments);
  }
  return block;
}

/** Marks of the inline nodes that only add a mark to their children. */
const NESTED_MARK = { emphasis: 'italic', strong: 'bold', strike: 'strike' } as const;

/**
 * `marks` is kept sorted (MARK_ORDER) on the way down, so spans can share the
 * array. `soft` is the text of a soft line break: a space, or "\n" with the
 * `breaks` option. With `map`, each span's place in the source is recorded.
 */
function lowerInto(
  nodes: readonly InlineNode[],
  marks: readonly Mark[],
  link: Pick<Span, 'link' | 'linkTitle'>,
  out: Span[],
  soft: string,
  map?: SegmentBuilder,
): void {
  const push = (span: Span, node: InlineNode) => {
    map?.record(node, span.text.length);
    out.push(link.link === undefined ? span : { ...span, ...link });
  };
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        push({ text: node.value, marks }, node);
        break;
      case 'softBreak':
        push({ text: soft, marks }, node);
        break;
      case 'hardBreak':
        push({ text: '\n', marks }, node);
        break;
      case 'code':
      case 'html':
        push({ text: node.value, marks: withMark(marks, node.type) }, node);
        break;
      case 'token':
        push({ text: node.value, marks, token: node.name }, node);
        break;
      case 'emphasis':
      case 'strong':
      case 'strike':
        lowerInto(node.children, withMark(marks, NESTED_MARK[node.type]), link, out, soft, map);
        break;
      case 'link':
        // Links cannot nest, so the destination simply replaces any outer one.
        lowerInto(node.children, marks, node.title ? { link: node.destination, linkTitle: node.title } : { link: node.destination }, out, soft, map);
        break;
      case 'image':
        push({ text: ATOM_CHAR, marks, image: imageAtom(node) }, node);
        break;
    }
  }
}


function imageAtom(node: ImageNode): ImageAtom {
  let alt = inlineNodesText(node.children, ' ');
  // The description ends with the alignment and size; the alt text does not.
  const suffix = imageSuffixText(node);
  if (suffix && alt.endsWith(suffix)) alt = alt.slice(0, -suffix.length);
  return {
    src: node.destination,
    alt,
    ...(node.title ? { title: node.title } : {}),
    ...(node.align ? { align: node.align } : {}),
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
  };
}

function withMark(marks: readonly Mark[], mark: Mark): readonly Mark[] {
  return marks.includes(mark) ? marks : sortMarks([...marks, mark]);
}

// ---------------------------------------------------------------------------
// Blocks

function isEmptyLine(content: readonly Span[]): boolean {
  const span = content.length === 1 ? content[0]! : null;
  return span !== null && span.text === '\u00a0' && span.marks.length === 0 && !span.link && !span.image;
}

/**
 * Lowers one block node into `out`. `quoted` is the blockquote the node is in,
 * for a node that is a child of a quote. `src` is the Markdown the tree came
 * from, when known (see `lowerQuote`).
 */
function lowerBlock(node: BlockNode, out: Block[], o: MarkdownOptions, ctx?: LowerContext, quoted?: QuoteKind, src?: SourceText): void {
  /** The block as it is in its quote, if any. Before its source map is recorded, which is keyed by the block object. */
  const q = <B extends QuotableBlock>(block: B): B => (quoted ? (withQuote(block, quoted) as B) : block);
  switch (node.type) {
    case 'paragraph': {
      // A paragraph of a quote is a quote block, which `lowerQuote` makes; here a paragraph is never quoted.
      const { content, map } = lowerContent(node.children, o, node.source, ctx);
      // A paragraph of only empty links (`[](/x)`) shows as an empty line, as elsewhere.
      if (isEmptyLine(content)) out.push(paragraph());
      else if (content.length > 0 || node.children.length > 0) out.push(mapped(paragraph(content), map, ctx));
      break;
    }
    case 'heading': {
      const { content, map } = lowerContent(node.children, o, node.source, ctx);
      out.push(mapped(q(heading(node.level, content)), map, ctx));
      break;
    }
    case 'thematicBreak':
      out.push(q(divider()));
      break;
    case 'blockQuote':
      lowerQuote(node, out, o, ctx, src);
      break;
    case 'list':
      lowerList(node, 0, out, o, quoted, ctx);
      break;
    case 'codeBlock': {
      const text = node.value.replace(/\n$/, '');
      out.push(mappedText(q(codeBlock(firstWord(node.info), text)), text, node.source, ctx));
      break;
    }
    case 'htmlBlock':
      out.push(mappedText(q(htmlBlock(node.value)), node.value, node.source, ctx));
      break;
    case 'raw':
      out.push(mappedText(q(rawBlock(node.name, node.value)), node.value, node.source, ctx));
      break;
    case 'table':
      out.push(q(table(node.align, node.rows.map((row) => row.map((cell) => lowerInlines(cell, o))))));
      break;
  }
}

/** The language of a fence: the first word of its info string. */
export function firstWord(info: string): string {
  return info.trim().split(/\s+/)[0] ?? '';
}

function listTypeOf(list: ListNode, item: ListItemNode): ListType {
  if (item.task) return 'task';
  return list.ordered ? 'ordered' : 'bullet';
}

// fitsModel holds for every list lowered here: an item has at most one
// paragraph, first, then only nested lists.

function lowerList(list: ListNode, depth: number, out: Block[], o: MarkdownOptions, quoted?: QuoteKind, ctx?: LowerContext): void {
  list.items.forEach((item, index) => {
    const first = item.children[0];
    const listType = listTypeOf(list, item);
    const { content, map } = first?.type === 'paragraph' ? lowerContent(first.children, o, first.source, ctx) : { content: [] };
    out.push(
      mapped(
        listItem(listType, content, {
          indent: Math.min(depth, MAX_INDENT),
          checked: item.checked,
          start: index === 0 && listType === 'ordered' ? list.start : undefined,
          quote: quoted,
        }),
        map,
        ctx,
      ),
    );
    for (const child of item.children) if (child.type === 'list') lowerList(child, depth + 1, out, o, quoted, ctx);
  });
}

/**
 * A quote's blocks: a `quote` block per paragraph, and every other child as
 * its own blocks marked as quoted. A quote inside the quote, or a list the
 * model cannot hold, becomes one quoted raw block holding its source without
 * the quote markers, when `src` is known; `fitsModel` keeps such a quote out
 * of here otherwise.
 */
function lowerQuote(node: BlockQuoteNode, out: Block[], o: MarkdownOptions, ctx?: LowerContext, src?: SourceText): void {
  const children = node.children;
  const alert = o.callouts === false ? null : calloutOf(children);
  const callout = alert?.type;
  const kind: QuoteKind = callout ?? 'quote';
  /** A child the model cannot hold, as a quoted raw block of its source. */
  const rawChild = (lines: SourceLines) => {
    if (src) out.push(withQuote(rawBlock('markdown', quotedSource(lines, src)), kind));
  };
  const start = out.length;
  children.forEach((child, i) => {
    const before = out.length;
    switch (child.type) {
      case 'paragraph': {
        const inlines = i === 0 && alert ? alert.rest : child.children;
        const { content, map } = lowerContent(inlines, o, child.source, ctx);
        if (isEmptyLine(content)) out.push(quote([], undefined, callout));
        else if (content.length > 0 || inlines.length > 0) out.push(mapped(quote(content, undefined, callout), map, ctx));
        break;
      }
      case 'list':
        if (fitsModel(child, 0)) lowerList(child, 0, out, o, kind, ctx);
        else if (child.lines) rawChild(child.lines);
        break;
      case 'blockQuote':
        if (child.lines) rawChild(child.lines);
        break;
      default:
        lowerBlock(child, out, o, ctx, kind, src);
    }
    src?.onQuoteChild?.(child, out.slice(before));
  });
  // An alert with nothing after its marker is an empty callout.
  if (callout && out.length === start) out.push(quote([], undefined, callout));
}

/**
 * The source of a block inside a quote, as it is in the quote: its lines
 * with one quote marker removed from each, without trailing blank lines. A
 * lazy continuation line has no marker and stays as it is.
 */
function quotedSource(lines: SourceLines, src: SourceText): string {
  const out: string[] = [];
  for (let n = lines.start; n <= lines.end; n++) {
    const from = src.lines.starts[n - 1];
    const to = src.lines.ends[n - 1];
    if (from === undefined || to === undefined) break;
    out.push(stripQuoteMarker(src.text.slice(from, Math.max(from, to))));
  }
  while (out.length > 1 && /^[ \t]*$/.test(out[out.length - 1]!)) out.pop();
  return out.join('\n');
}

/**
 * A line without its block quote marker, as CommonMark reads it: up to three
 * spaces, `>`, and one following space, if any, are the marker. Tabs are
 * read with a tab stop of 4, so the whitespace after the marker is written
 * as the spaces it stands for, less the one column the marker takes: in
 * `>\t\tfoo`, the first tab reaches column 4, the second column 8, and `foo`
 * keeps six columns of indentation (CommonMark example 6).
 */
export function stripQuoteMarker(line: string): string {
  const marker = /^ {0,3}>/.exec(line);
  if (!marker) return line;
  let column = marker[0].length;
  let i = column;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    column += line[i] === '\t' ? 4 - (column % 4) : 1;
    i++;
  }
  return ' '.repeat(Math.max(0, column - (marker[0].length + 1))) + line.slice(i);
}

const ALERT_MARKER = new RegExp(`^\\[!(${CALLOUT_TYPES.join('|')})\\]$`, 'i');

/**
 * A GitHub alert: the first paragraph starts with a marker such as `[!NOTE]`
 * alone on its line. Returns its type and the paragraph's content after the marker line.
 */
export function calloutOf(children: readonly BlockNode[]): { type: CalloutType; rest: readonly InlineNode[] } | null {
  const first = children[0];
  if (first?.type !== 'paragraph') return null;
  const [marker, after] = first.children;
  const m = marker?.type === 'text' ? ALERT_MARKER.exec(marker.value) : null;
  if (!m) return null;
  if (after && after.type !== 'softBreak' && after.type !== 'hardBreak') return null;
  return { type: m[1]!.toLowerCase() as CalloutType, rest: first.children.slice(2) };
}
