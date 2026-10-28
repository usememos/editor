// Walking the syntax tree (`parseAst`) and mapping it back to the source, for
// a host that reads a document as data: counting tasks, listing images,
// taking an excerpt. The tree is read-only; edits go through the document
// model or through the source text at the positions reported here.

import type { BlockNode, ContentSource, InlineNode, ListItemNode, Range, Root } from './ast';
import { type LineTable, SegmentBuilder, lineTable } from './sourceMap';

/** A node of the syntax tree: the root, a block, a list item or an inline node. */
export type TreeNode = Root | BlockNode | ListItemNode | InlineNode;

/**
 * Called for every node in document order with its ancestors, the root
 * first. Return false to skip the node's children.
 */
export type Visitor = (node: TreeNode, ancestors: readonly TreeNode[]) => void | false;

/**
 * The nodes under `node`, in document order: a list's items, an item's
 * blocks, a table's cells' inline nodes row by row, an image's description.
 */
export function nodeChildren(node: TreeNode): readonly TreeNode[] {
  switch (node.type) {
    case 'root':
    case 'blockQuote':
    case 'listItem':
    case 'paragraph':
    case 'heading':
    case 'emphasis':
    case 'strong':
    case 'strike':
    case 'link':
    case 'image':
      return node.children;
    case 'list':
      return node.items;
    case 'table':
      return node.rows.flatMap((row) => row.flat());
    default:
      return [];
  }
}

/** Visits `node` and everything under it, in document order. */
export function visit(node: TreeNode, visitor: Visitor): void {
  const ancestors: TreeNode[] = [];
  const walk = (n: TreeNode): void => {
    if (visitor(n, ancestors) === false) return;
    ancestors.push(n);
    for (const child of nodeChildren(n)) walk(child);
    ancestors.pop();
  };
  walk(node);
}

/**
 * Where a range of a leaf block's content is in the source text: the
 * offsets of an inline node's `pos`, or of a code block's text, mapped back
 * through the block's `source` (`ParagraphNode.source`, a table cell's entry
 * in `TableNode.sources`). The result is `from` inclusive, `to` exclusive,
 * and spans the prefixes of the lines between (quote markers, list
 * indentation) when the range crosses a line. `text` is the Markdown the
 * tree was parsed from, or its `lineTable`, for many lookups in one text.
 */
export function sourceRange(text: string | LineTable, source: ContentSource, range: Range): Range {
  const table = typeof text === 'string' ? lineTable(text) : text;
  const b = new SegmentBuilder(source, table);
  return { from: b.source(range.from), to: b.source(range.to) };
}
