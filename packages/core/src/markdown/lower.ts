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
//   one raw Markdown block holding its source. Without the source
//   (`astToDoc`, used by tests), it is flattened instead: the paragraphs of
//   an item are joined with "\n", other blocks in an item follow it, and
//   other blocks in a quote become text lines in a quote block.
// - Links, images, code spans and raw HTML become span attributes and marks.
// - A top-level paragraph holding only a no-break space (`&nbsp;`) becomes an
//   empty paragraph: that is how the serializer writes empty lines.

import {
  ATOM_CHAR,
  type Align,
  type Block,
  type Doc,
  type HeadingLevel,
  type Inline,
  type ListType,
  type Mark,
  MAX_INDENT,
  type Span,
  codeBlock,
  concatInline,
  divider,
  heading,
  htmlBlock,
  listItem,
  normalizeInline,
  paragraph,
  plain,
  quote,
  rawBlock,
  sortMarks,
  table,
} from '../model';
import type { BlockNode, InlineNode, ListItemNode, ListNode, Root } from './ast';
import { DEFAULT_MARKDOWN, type MarkdownOptions } from './options';

export function astToDoc(root: Root, options: MarkdownOptions = DEFAULT_MARKDOWN): Doc {
  const blocks: Block[] = [];
  for (const node of root.children) lowerBlock(node, blocks, options);
  return { blocks };
}

/**
 * Lowers one top-level block node. With its `source`, structure the model
 * cannot hold becomes one raw Markdown block holding that source, instead of
 * being flattened.
 */
export function lowerTopLevel(node: BlockNode, options: MarkdownOptions = DEFAULT_MARKDOWN, source?: string): Block[] {
  if (source !== undefined && !fitsModel(node, 0)) return [rawBlock('markdown', source)];
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

/** `marks` is kept sorted (MARK_ORDER) on the way down, so spans can share the array. */
/** `soft` is the text of a soft line break: a space, or "\n" with the `breaks` option. */
function lowerInto(
  nodes: readonly InlineNode[],
  marks: readonly Mark[],
  link: string | undefined,
  out: Span[],
  soft: string,
): void {
  const push = (text: string, spanMarks: readonly Mark[]) => {
    out.push(link === undefined ? { text, marks: spanMarks } : { text, marks: spanMarks, link });
  };
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        push(node.value, marks);
        break;
      case 'softBreak':
        push(soft, marks);
        break;
      case 'hardBreak':
        push('\n', marks);
        break;
      case 'code':
        push(node.value, withMark(marks, 'code'));
        break;
      case 'html':
        push(node.value, withMark(marks, 'html'));
        break;
      case 'token': {
        const span: Span = { text: node.value, marks, token: node.name };
        out.push(link === undefined ? span : { ...span, link });
        break;
      }
      case 'emphasis':
        lowerInto(node.children, withMark(marks, 'italic'), link, out, soft);
        break;
      case 'strong':
        lowerInto(node.children, withMark(marks, 'bold'), link, out, soft);
        break;
      case 'strike':
        lowerInto(node.children, withMark(marks, 'strike'), link, out, soft);
        break;
      case 'link':
        // Links cannot nest, so the destination simply replaces any outer one.
        lowerInto(node.children, marks, node.destination, out, soft);
        break;
      case 'image': {
        const alt = plainText(node.children);
        const image = node.title ? { src: node.destination, alt, title: node.title } : { src: node.destination, alt };
        const span: Span = { text: ATOM_CHAR, marks, image };
        out.push(link === undefined ? span : { ...span, link });
        break;
      }
    }
  }
}

function withMark(marks: readonly Mark[], mark: Mark): readonly Mark[] {
  return marks.includes(mark) ? marks : sortMarks([...marks, mark]);
}

/** Plain text of inline nodes, as used for image alt text. */
function plainText(nodes: readonly InlineNode[]): string {
  let s = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'code':
      case 'html':
      case 'token':
        s += node.value;
        break;
      case 'softBreak':
        s += ' ';
        break;
      case 'hardBreak':
        s += '\n';
        break;
      default:
        s += plainText(node.children);
    }
  }
  return s;
}

const NEWLINE: Inline = [{ text: '\n', marks: [] }];

function joinLines(lines: readonly Inline[]): Span[] {
  if (lines.length === 1) return normalizeInline(lines[0]!);
  return concatInline(...lines.flatMap((line, i) => (i === 0 ? [line] : [NEWLINE, line])));
}

// ---------------------------------------------------------------------------
// Blocks

function isEmptyLine(content: Inline): boolean {
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
      out.push(heading(node.level as HeadingLevel, lowerInlines(node.children, o)));
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
      out.push(table(node.align as Align[], node.rows.map((row) => row.map((cell) => lowerInlines(cell, o)))));
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

function lowerList(list: ListNode, depth: number, out: Block[], o: MarkdownOptions): void {
  list.items.forEach((item, index) => {
    const paragraphs: Inline[] = [];
    const rest: BlockNode[] = [];
    for (const child of item.children) {
      if (child.type === 'paragraph') {
        const content = lowerInlines(child.children, o);
        if (content.length > 0) paragraphs.push(content);
      } else {
        rest.push(child);
      }
    }
    const listType = listTypeOf(list, item);
    out.push(
      listItem(listType, joinLines(paragraphs), {
        indent: Math.min(depth, MAX_INDENT),
        checked: item.checked,
        start: index === 0 && listType === 'ordered' ? list.start : undefined,
      }),
    );
    for (const child of rest) {
      if (child.type === 'list') lowerList(child, depth + 1, out, o);
      else lowerBlock(child, out, o);
    }
  });
}

function lowerQuote(children: readonly BlockNode[], out: Block[], o: MarkdownOptions): void {
  for (const child of children) {
    if (child.type === 'paragraph') {
      const content = lowerInlines(child.children, o);
      if (content.length > 0) out.push(quote(content));
    } else if (child.type === 'blockQuote') {
      lowerQuote(child.children, out, o);
    } else {
      const lines = quoteLines(child, o);
      if (lines.length > 0) out.push(quote(joinLines(lines)));
    }
  }
}

/** A block inside a quote as lines of text. */
function quoteLines(node: BlockNode, o: MarkdownOptions): Inline[] {
  switch (node.type) {
    case 'paragraph':
    case 'heading': {
      const content = lowerInlines(node.children, o);
      return content.length > 0 ? [content] : [];
    }
    case 'codeBlock':
      return node.value === '' ? [] : node.value.replace(/\n$/, '').split('\n').map(plain);
    case 'htmlBlock':
    case 'raw':
      return node.value.split('\n').map(plain);
    case 'thematicBreak':
      return [plain('---')];
    case 'table':
      return node.rows.map((row) =>
        joinCells(row.map((cell) => lowerInlines(cell, o))),
      );
    case 'blockQuote':
      return node.children.flatMap((c) => quoteLines(c, o));
    case 'list':
      return node.items.flatMap((item, index) => {
        let marker = node.ordered ? `${node.start + index}${node.marker}` : node.marker;
        if (item.task) marker += item.checked ? ' [x]' : ' [ ]';
        const lines = item.children.flatMap((c) => quoteLines(c, o));
        const [first, ...more] = lines;
        if (!first) return [plain(marker)];
        return [concatInline(plain(marker + ' '), first), ...more];
      });
  }
}

function joinCells(cells: readonly Inline[]): Span[] {
  return concatInline(...cells.flatMap((cell, i) => (i === 0 ? [cell] : [plain(' | '), cell])));
}
