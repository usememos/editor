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
//   paragraph holding only a no-break space an empty one. A list in a quote
//   becomes list items marked as quoted. A GitHub alert (first line `[!NOTE]`
//   and the like) sets `callout` on all of them.
// - A top-level list or quote the model cannot hold (see `fitsModel`) becomes
//   one raw Markdown block holding its source.
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
} from '../model';
import {
  type BlockNode,
  type ContentSource,
  type ImageNode,
  type InlineNode,
  type ListItemNode,
  type ListNode,
  imageSuffixText,
  inlineNodesText,
} from './ast';
import { DEFAULT_MARKDOWN, type MarkdownOptions } from './options';
import { type LowerContext, SegmentBuilder } from './sourceMap';

/**
 * Lowers one top-level block node. Structure the model cannot hold becomes
 * one raw Markdown block holding `source`, the node's Markdown. `before` is
 * the last block lowered before it.
 */
export function lowerTopLevel(node: BlockNode, options: MarkdownOptions, source: string, before?: Block): Block[] {
  return lowerIfFits(node, options, before) ?? [rawBlock('markdown', source)];
}

/**
 * Lowers one block node, or returns null when the model cannot hold its
 * structure (see `fitsModel`). With `ctx`, each block that holds text gets a
 * source map (see `sourceMap.ts`).
 */
export function lowerIfFits(node: BlockNode, options: MarkdownOptions, before?: Block, ctx?: LowerContext): Block[] | null {
  if (!fitsModel(node, 0)) return null;
  const blocks: Block[] = [];
  lowerBlock(node, blocks, options, ctx);
  // A blockquote right after one of the same kind starts a new blockquote: a blank line was between them.
  const first = blocks[0];
  if (node.type === 'blockQuote' && (first?.type === 'quote' || first?.type === 'listItem') && quoteKind(before) === quoteKind(first)) {
    blocks[0] = { ...first, quoteStart: true };
    const map = ctx?.maps.get(first);
    if (map) ctx!.maps.set(blocks[0], map);
  }
  return blocks;
}

/**
 * True if lowering keeps the structure: a quote holds only paragraphs and
 * lists, and a list item holds at most one paragraph, first, followed only by
 * nested lists no deeper than MAX_INDENT.
 */
function fitsModel(node: BlockNode, depth: number): boolean {
  switch (node.type) {
    case 'blockQuote':
      return node.children.every((child) => child.type === 'paragraph' || (child.type === 'list' && fitsModel(child, 0)));
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

function lowerBlock(node: BlockNode, out: Block[], o: MarkdownOptions, ctx?: LowerContext): void {
  switch (node.type) {
    case 'paragraph': {
      const { content, map } = lowerContent(node.children, o, node.source, ctx);
      // A paragraph of only empty links (`[](/x)`) shows as an empty line, as elsewhere.
      if (isEmptyLine(content)) out.push(paragraph());
      else if (content.length > 0 || node.children.length > 0) out.push(mapped(paragraph(content), map, ctx));
      break;
    }
    case 'heading': {
      const { content, map } = lowerContent(node.children, o, node.source, ctx);
      out.push(mapped(heading(node.level, content), map, ctx));
      break;
    }
    case 'thematicBreak':
      out.push(divider());
      break;
    case 'blockQuote':
      lowerQuote(node.children, out, o, ctx);
      break;
    case 'list':
      lowerList(node, 0, out, o, undefined, ctx);
      break;
    case 'codeBlock': {
      const text = node.value.replace(/\n$/, '');
      out.push(mappedText(codeBlock(firstWord(node.info), text), text, node.source, ctx));
      break;
    }
    case 'htmlBlock':
      out.push(mappedText(htmlBlock(node.value), node.value, node.source, ctx));
      break;
    case 'raw':
      out.push(mappedText(rawBlock(node.name, node.value), node.value, node.source, ctx));
      break;
    case 'table':
      out.push(table(node.align, node.rows.map((row) => row.map((cell) => lowerInlines(cell, o)))));
      break;
  }
}

function firstWord(info: string): string {
  return info.trim().split(/\s+/)[0] ?? '';
}

function listTypeOf(list: ListNode, item: ListItemNode): ListType {
  if (item.task) return 'task';
  return list.ordered ? 'ordered' : 'bullet';
}

// fitsModel holds for every node lowered here: a list item has at most one
// paragraph, first, then only nested lists, and a quote holds only paragraphs
// and lists.

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

function lowerQuote(children: readonly BlockNode[], out: Block[], o: MarkdownOptions, ctx?: LowerContext): void {
  const alert = o.callouts === false ? null : calloutOf(children);
  const callout = alert?.type;
  const start = out.length;
  children.forEach((child, i) => {
    if (child.type === 'list') lowerList(child, 0, out, o, callout ?? 'quote', ctx);
    if (child.type !== 'paragraph') return;
    const inlines = i === 0 && alert ? alert.rest : child.children;
    const { content, map } = lowerContent(inlines, o, child.source, ctx);
    if (isEmptyLine(content)) out.push(quote([], undefined, callout));
    else if (content.length > 0 || inlines.length > 0) out.push(mapped(quote(content, undefined, callout), map, ctx));
  });
  // An alert with nothing after its marker is an empty callout.
  if (callout && out.length === start) out.push(quote([], undefined, callout));
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
