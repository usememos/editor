// Lowering: Markdown syntax tree → the editor's flat document model.
//
// The model has no nesting, so some structure is flattened (these rules are
// part of the product spec):
//
// - Soft line breaks become spaces; hard line breaks become "\n".
// - Each list item becomes a `listItem` block whose `indent` is its nesting
//   depth (capped at MAX_INDENT). An ordered list keeps its start number on
//   its first item. GFM task items become `task` items.
// - All paragraphs of a list item are joined with "\n" into the item. Other
//   blocks inside an item (code, heading, quote, table, HTML, divider) become
//   top-level blocks right after the item; nested lists follow as deeper items.
// - In a block quote each paragraph becomes one `quote` block. Any other
//   block inside a quote is flattened to text lines in its own quote block:
//   nested quotes flatten to one level, list items keep their marker text
//   ("- ", "1. ", "- [ ] "), headings become their text, code and HTML become
//   their lines.
// - Links, images, code spans and raw HTML become span attributes and marks.

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
  sortMarks,
  table,
} from '../model';
import type { BlockNode, InlineNode, ListItemNode, ListNode, Root } from './ast';

export function astToDoc(root: Root): Doc {
  const blocks: Block[] = [];
  for (const node of root.children) lowerBlock(node, blocks);
  return { blocks };
}

// ---------------------------------------------------------------------------
// Inline content

export function lowerInlines(nodes: readonly InlineNode[]): Span[] {
  const out: Span[] = [];
  lowerInto(nodes, [], undefined, out);
  return normalizeInline(out);
}

/** `marks` is kept sorted (MARK_ORDER) on the way down, so spans can share the array. */
function lowerInto(nodes: readonly InlineNode[], marks: readonly Mark[], link: string | undefined, out: Span[]): void {
  const push = (text: string, spanMarks: readonly Mark[]) => {
    out.push(link === undefined ? { text, marks: spanMarks } : { text, marks: spanMarks, link });
  };
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        push(node.value, marks);
        break;
      case 'softBreak':
        push(' ', marks);
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
      case 'emphasis':
        lowerInto(node.children, withMark(marks, 'italic'), link, out);
        break;
      case 'strong':
        lowerInto(node.children, withMark(marks, 'bold'), link, out);
        break;
      case 'strike':
        lowerInto(node.children, withMark(marks, 'strike'), link, out);
        break;
      case 'link':
        // Links cannot nest, so the destination simply replaces any outer one.
        lowerInto(node.children, marks, node.destination, out);
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

function lowerBlock(node: BlockNode, out: Block[]): void {
  switch (node.type) {
    case 'paragraph': {
      const content = lowerInlines(node.children);
      if (content.length > 0) out.push(paragraph(content));
      break;
    }
    case 'heading':
      out.push(heading(node.level as HeadingLevel, lowerInlines(node.children)));
      break;
    case 'thematicBreak':
      out.push(divider());
      break;
    case 'blockQuote':
      lowerQuote(node.children, out);
      break;
    case 'list':
      lowerList(node, 0, out);
      break;
    case 'codeBlock':
      out.push(codeBlock(firstWord(node.info), node.value.replace(/\n$/, '')));
      break;
    case 'htmlBlock':
      out.push(htmlBlock(node.value));
      break;
    case 'table':
      out.push(table(node.align as Align[], node.rows.map((row) => row.map((cell) => lowerInlines(cell)))));
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

function lowerList(list: ListNode, depth: number, out: Block[]): void {
  list.items.forEach((item, index) => {
    const paragraphs: Inline[] = [];
    const rest: BlockNode[] = [];
    for (const child of item.children) {
      if (child.type === 'paragraph') {
        const content = lowerInlines(child.children);
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
      if (child.type === 'list') lowerList(child, depth + 1, out);
      else lowerBlock(child, out);
    }
  });
}

function lowerQuote(children: readonly BlockNode[], out: Block[]): void {
  for (const child of children) {
    if (child.type === 'paragraph') {
      const content = lowerInlines(child.children);
      if (content.length > 0) out.push(quote(content));
    } else if (child.type === 'blockQuote') {
      lowerQuote(child.children, out);
    } else {
      const lines = quoteLines(child);
      if (lines.length > 0) out.push(quote(joinLines(lines)));
    }
  }
}

/** A block inside a quote as lines of text. */
function quoteLines(node: BlockNode): Inline[] {
  switch (node.type) {
    case 'paragraph':
    case 'heading': {
      const content = lowerInlines(node.children);
      return content.length > 0 ? [content] : [];
    }
    case 'codeBlock':
      return node.value === '' ? [] : node.value.replace(/\n$/, '').split('\n').map(plain);
    case 'htmlBlock':
      return node.value.split('\n').map(plain);
    case 'thematicBreak':
      return [plain('---')];
    case 'table':
      return node.rows.map((row) =>
        joinCells(row.map((cell) => lowerInlines(cell))),
      );
    case 'blockQuote':
      return node.children.flatMap(quoteLines);
    case 'list':
      return node.items.flatMap((item, index) => {
        let marker = node.ordered ? `${node.start + index}${node.marker}` : node.marker;
        if (item.task) marker += item.checked ? ' [x]' : ' [ ]';
        const lines = item.children.flatMap(quoteLines);
        const [first, ...more] = lines;
        if (!first) return [plain(marker)];
        return [concatInline(plain(marker + ' '), first), ...more];
      });
  }
}

function joinCells(cells: readonly Inline[]): Span[] {
  return concatInline(...cells.flatMap((cell, i) => (i === 0 ? [cell] : [plain(' | '), cell])));
}
