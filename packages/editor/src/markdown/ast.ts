// Markdown syntax tree.
//
// `parseAst` (blocks.ts) turns Markdown source into this tree. It follows the
// CommonMark 0.31.2 spec plus the GFM extensions for tables, task list items
// and strikethrough. The tree keeps everything the spec's reference HTML
// output needs, so `renderAstToHtml` (html.ts) can be checked against the
// spec examples. `loadMarkdown` (source.ts) then lowers each top-level block
// to the editor's flat document model (lower.ts).
//
// Strings in the tree are final: backslash escapes and entities are already
// decoded, and link reference definitions are already resolved.

import type { Align } from '../model';

export type InlineNode =
  | TextNode
  | { readonly type: 'softBreak' }
  | { readonly type: 'hardBreak' }
  | { readonly type: 'code'; readonly value: string }
  /** Raw inline HTML, verbatim. */
  | { readonly type: 'html'; readonly value: string }
  /** A token of an inline syntax extension (`name`), verbatim source. */
  | { readonly type: 'token'; readonly name: string; readonly value: string }
  | { readonly type: 'emphasis'; readonly children: InlineNode[] }
  | { readonly type: 'strong'; readonly children: InlineNode[] }
  /** GFM strikethrough (`~text~` or `~~text~~`). */
  | { readonly type: 'strike'; readonly children: InlineNode[] }
  | LinkNode
  | ImageNode;

export interface TextNode {
  readonly type: 'text';
  readonly value: string;
}

export interface LinkNode {
  readonly type: 'link';
  /** Decoded destination, not yet percent-encoded. */
  readonly destination: string;
  readonly title: string;
  readonly children: InlineNode[];
}

export interface ImageNode {
  readonly type: 'image';
  readonly destination: string;
  readonly title: string;
  /** The image description; its plain text is the alt text. */
  readonly children: InlineNode[];
}

export type BlockNode =
  | ParagraphNode
  | HeadingNode
  | { readonly type: 'thematicBreak' }
  | BlockQuoteNode
  | ListNode
  | CodeBlockNode
  | HtmlBlockNode
  | RawNode
  | TableNode;

export interface ParagraphNode {
  readonly type: 'paragraph';
  readonly children: InlineNode[];
}

export interface HeadingNode {
  readonly type: 'heading';
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  /** True for a setext heading (underlined with `=` or `-`). */
  readonly setext: boolean;
  readonly children: InlineNode[];
}

export interface BlockQuoteNode {
  readonly type: 'blockQuote';
  readonly children: BlockNode[];
}

export interface ListNode {
  readonly type: 'list';
  readonly ordered: boolean;
  /** Number of the first item (ordered lists only; 1 for bullet lists). */
  readonly start: number;
  /** The bullet (`-`, `+`, `*`) or the ordered delimiter (`.`, `)`). */
  readonly marker: string;
  /** A tight list renders its paragraphs without `<p>` tags. */
  readonly tight: boolean;
  readonly items: ListItemNode[];
}

export interface ListItemNode {
  readonly type: 'listItem';
  /** GFM task list item: the item began with `[ ]`, `[x]` or `[X]`. */
  readonly task: boolean;
  readonly checked: boolean;
  readonly children: BlockNode[];
}

export interface CodeBlockNode {
  readonly type: 'codeBlock';
  readonly fenced: boolean;
  /** Info string of a fenced block (decoded), or "". */
  readonly info: string;
  /** Code text. Ends with "\n" unless empty. */
  readonly value: string;
}

export interface HtmlBlockNode {
  readonly type: 'htmlBlock';
  /** Raw HTML, verbatim, without the final line ending. */
  readonly value: string;
}

/** A block of a block syntax extension (`name`): its source lines, verbatim, without the final line ending. */
export interface RawNode {
  readonly type: 'raw';
  readonly name: string;
  readonly value: string;
}

export type TableAlign = Align;

export interface TableNode {
  readonly type: 'table';
  readonly align: TableAlign[];
  /** `rows[0]` is the header row. Every row has `align.length` cells. */
  readonly rows: InlineNode[][][];
}

/** Source lines of a top-level block, 1-based and inclusive. */
export interface SourceLines {
  readonly start: number;
  readonly end: number;
}

export interface Root {
  readonly type: 'root';
  readonly children: BlockNode[];
  /** Source lines of each child, by index. */
  readonly lines: readonly SourceLines[];
  /** Source text of every link reference definition, in order. */
  readonly definitions: readonly string[];
}

/**
 * The text of inline nodes without their markup, as in image alt text. `soft`
 * is the text of a soft line break; a hard line break is "\n".
 */
export function inlineNodesText(nodes: readonly InlineNode[], soft: string): string {
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
        s += soft;
        break;
      case 'hardBreak':
        s += '\n';
        break;
      default:
        s += inlineNodesText(node.children, soft);
    }
  }
  return s;
}
