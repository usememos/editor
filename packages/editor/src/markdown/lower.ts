// Lowering: Markdown syntax tree → the editor's flat document model.
//
// The model has no nesting (these rules are part of the product spec):
//
// - Soft line breaks become spaces (or "\n" with the `breaks` option); hard
//   line breaks become "\n".
// - Each list item becomes a `listItem` block whose `indent` is its nesting
//   depth. An ordered list keeps its start number on its first item. GFM
//   task items become `task` items.
// - In a block quote each paragraph becomes one `quote` block.
// - A top-level list or quote the model cannot hold (see `fitsModel`) becomes
//   one raw Markdown block holding its source.
// - Links, images, code spans and raw HTML become span attributes and marks.
// - A top-level paragraph holding only a no-break space (`&nbsp;`) becomes an
//   empty paragraph: that is how the serializer writes empty lines.

import {
  ATOM_CHAR,
  type Block,
  type ImageAtom,
  type ListType,
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
  rawBlock,
  sortMarks,
  table,
} from '../model';
import { type BlockNode, type ImageNode, type InlineNode, type ListItemNode, type ListNode, imageSuffixText, inlineNodesText } from './ast';
import { DEFAULT_MARKDOWN, type MarkdownOptions } from './options';

/**
 * Lowers one top-level block node. Structure the model cannot hold becomes
 * one raw Markdown block holding `source`, the node's Markdown.
 */
export function lowerTopLevel(node: BlockNode, options: MarkdownOptions, source: string): Block[] {
  if (!fitsModel(node, 0)) return [rawBlock('markdown', source)];
  const blocks: Block[] = [];
  lowerBlock(node, blocks, options);
  return blocks;
}

/**
 * True if lowering keeps the structure: a quote holds only paragraphs, and a
 * list item holds at most one paragraph, first, followed only by nested lists
 * no deeper than MAX_INDENT.
 */
function fitsModel(node: BlockNode, depth: number): boolean {
  switch (node.type) {
    case 'blockQuote':
      return node.children.every((child) => child.type === 'paragraph');
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

export function lowerInlines(nodes: readonly InlineNode[], options: MarkdownOptions = DEFAULT_MARKDOWN): Span[] {
  const out: Span[] = [];
  lowerInto(nodes, [], undefined, out, options.breaks ? '\n' : ' ');
  return normalizeInline(out);
}

/** Marks of the inline nodes that only add a mark to their children. */
const NESTED_MARK = { emphasis: 'italic', strong: 'bold', strike: 'strike' } as const;

/**
 * `marks` is kept sorted (MARK_ORDER) on the way down, so spans can share the
 * array. `soft` is the text of a soft line break: a space, or "\n" with the
 * `breaks` option.
 */
function lowerInto(
  nodes: readonly InlineNode[],
  marks: readonly Mark[],
  link: string | undefined,
  out: Span[],
  soft: string,
): void {
  const push = (span: Span) => out.push(link === undefined ? span : { ...span, link });
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        push({ text: node.value, marks });
        break;
      case 'softBreak':
        push({ text: soft, marks });
        break;
      case 'hardBreak':
        push({ text: '\n', marks });
        break;
      case 'code':
      case 'html':
        push({ text: node.value, marks: withMark(marks, node.type) });
        break;
      case 'token':
        push({ text: node.value, marks, token: node.name });
        break;
      case 'emphasis':
      case 'strong':
      case 'strike':
        lowerInto(node.children, withMark(marks, NESTED_MARK[node.type]), link, out, soft);
        break;
      case 'link':
        // Links cannot nest, so the destination simply replaces any outer one.
        lowerInto(node.children, marks, node.destination, out, soft);
        break;
      case 'image':
        push({ text: ATOM_CHAR, marks, image: imageAtom(node) });
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

function lowerBlock(node: BlockNode, out: Block[], o: MarkdownOptions): void {
  switch (node.type) {
    case 'paragraph': {
      const content = lowerInlines(node.children, o);
      if (isEmptyLine(content)) out.push(paragraph());
      else if (content.length > 0) out.push(paragraph(content));
      break;
    }
    case 'heading':
      out.push(heading(node.level, lowerInlines(node.children, o)));
      break;
    case 'thematicBreak':
      out.push(divider());
      break;
    case 'blockQuote':
      lowerQuote(node.children, out, o);
      break;
    case 'list':
      lowerList(node, 0, out, o);
      break;
    case 'codeBlock':
      out.push(codeBlock(firstWord(node.info), node.value.replace(/\n$/, '')));
      break;
    case 'htmlBlock':
      out.push(htmlBlock(node.value));
      break;
    case 'raw':
      out.push(rawBlock(node.name, node.value));
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
// paragraph, first, then only nested lists, and a quote holds only paragraphs.

function lowerList(list: ListNode, depth: number, out: Block[], o: MarkdownOptions): void {
  list.items.forEach((item, index) => {
    const first = item.children[0];
    const listType = listTypeOf(list, item);
    out.push(
      listItem(listType, first?.type === 'paragraph' ? lowerInlines(first.children, o) : [], {
        indent: Math.min(depth, MAX_INDENT),
        checked: item.checked,
        start: index === 0 && listType === 'ordered' ? list.start : undefined,
      }),
    );
    for (const child of item.children) if (child.type === 'list') lowerList(child, depth + 1, out, o);
  });
}

function lowerQuote(children: readonly BlockNode[], out: Block[], o: MarkdownOptions): void {
  for (const child of children) {
    if (child.type !== 'paragraph') continue;
    const content = lowerInlines(child.children, o);
    if (content.length > 0) out.push(quote(content));
  }
}
