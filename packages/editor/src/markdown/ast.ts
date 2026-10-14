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
  /**
   * An alignment and a size written after the description, as in Obsidian:
   * `![alt|320](src)`, `![alt|center](src)` or `![alt|center|320x200](src)`.
   * The description still ends with them; see `imageSuffix`. Not part of
   * CommonMark, so the spec HTML ignores them.
   */
  readonly align?: ImageNodeAlign;
  readonly width?: number;
  readonly height?: number;
}

export type ImageNodeAlign = 'left' | 'center' | 'right';

/** What an image description ends with: an alignment, a size, or both. */
export interface ImageSuffix {
  readonly align?: ImageNodeAlign;
  readonly width?: number;
  readonly height?: number;
  /** Where the suffix starts in the text. */
  readonly index: number;
}

/**
 * The size at the end of an image description: `|320` or `|320x200`, whole
 * CSS pixels from 1 to 99999.
 */
const IMAGE_SIZE = /\|([1-9][0-9]{0,4})(?:x([1-9][0-9]{0,4}))?$/;
/** An alignment, optionally followed by a size: `|center` or `|center|320`. */
const IMAGE_ALIGN = /\|(left|center|right)(?:\|([1-9][0-9]{0,4})(?:x([1-9][0-9]{0,4}))?)?$/;

/** True when the character after `before` is escaped by an odd number of backslashes. */
const escapedAfter = (before: string) => /(^|[^\\])(\\\\)*\\$/.test(before);

/**
 * The alignment and size at the end of an image description, written as
 * text: `|center`, `|320`, `|320x200` or `|center|320`. The alignment comes
 * first, as in Obsidian image plugins. A `|` escaped with a backslash does
 * not start a suffix; neither does `&#124;`, which is not a `|` in the source.
 * With `source` false, `text` is plain text in which escapes are already gone.
 */
export function imageSuffix(text: string, source = true): ImageSuffix | null {
  const aligned = IMAGE_ALIGN.exec(text);
  if (aligned && !(source && escapedAfter(text.slice(0, aligned.index)))) {
    return {
      align: aligned[1] as ImageNodeAlign,
      ...(aligned[2] ? { width: Number(aligned[2]) } : {}),
      ...(aligned[3] ? { height: Number(aligned[3]) } : {}),
      index: aligned.index,
    };
  }
  const size = IMAGE_SIZE.exec(text);
  if (size && !(source && escapedAfter(text.slice(0, size.index)))) {
    return { width: Number(size[1]), ...(size[2] ? { height: Number(size[2]) } : {}), index: size.index };
  }
  return null;
}

/** The text of an image suffix: `|center|320x200`, or '' for none. A height without a width is not written. */
export function imageSuffixText(s: { readonly align?: ImageNodeAlign; readonly width?: number; readonly height?: number }): string {
  const size = s.width ? `|${s.width}${s.height ? `x${s.height}` : ''}` : '';
  return (s.align ? `|${s.align}` : '') + size;
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
