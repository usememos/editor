// Block structure parser (CommonMark 0.31.2 sections 4 and 5, plus GFM tables
// and task list items).
//
// Phase one of the spec's two-phase algorithm (appendix "A parsing strategy"):
// each line is matched against the open container blocks, new blocks are
// started, and the remaining text is added to the innermost block. When all
// lines are consumed, phase two parses the inline content of paragraphs,
// headings and table cells, with all link reference definitions known.
//
// The structure follows the reference implementation's design: every block
// type defines how a line continues it (`continueBlock`), what happens when it
// closes (`finalize`), and the list of block starts is tried in order.

import type { BlockNode, ListItemNode, Root, SourceLines, TableAlign } from './ast';
import { CLOSETAG, OPENTAG, type RefMap, extractReferences, parseInlines, unescapeString } from './inline';
import { type BlockSyntaxMatcher, DEFAULT_MARKDOWN, type MarkdownOptions, type ResolvedMarkdown, resolveMarkdown } from './options';

/** Parses Markdown source into a syntax tree. */
export function parseAst(src: string, options: MarkdownOptions = DEFAULT_MARKDOWN): Root {
  return new BlockParser(resolveMarkdown(options)).parse(src);
}

// ---------------------------------------------------------------------------
// Patterns

const CODE_INDENT = 4;
/**
 * Container blocks nested deeper than this are not started; the line stays
 * text. Not part of the spec: it keeps absurd input (thousands of ">") from
 * exhausting the stack in the recursive tree walks.
 */
const MAX_NESTING = 100;
/**
 * Empty cells that short table rows may add, at least: a row with fewer
 * cells than the header is filled with empty ones, so a wide header over
 * many short rows makes columns times rows cells. As cmark-gfm does, a table
 * ends where the filled cells would pass a limit, here the larger of this
 * and the document's length, which keeps the work linear.
 */
const MIN_FILLED_CELLS = 65_536;

const reHtmlBlockOpen: readonly RegExp[] = [
  /^$/, // unused: block types are numbered from 1
  /^<(?:script|pre|textarea|style)(?:[ \t>]|$)/i,
  /^<!--/,
  /^<[?]/,
  /^<![A-Za-z]/,
  /^<!\[CDATA\[/,
  /^<[/]?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[123456]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|[/]?>|$)/i,
  new RegExp(`^(?:${OPENTAG}|${CLOSETAG})[ \\t]*$`, 'i'),
];

/** True when `text` at the start of a line would start an HTML block that can interrupt a paragraph (types 1 to 6). */
export function interruptsParagraph(text: string): boolean {
  for (let type = 1; type <= 6; type++) if (reHtmlBlockOpen[type]!.test(text)) return true;
  return false;
}

const reHtmlBlockClose: readonly RegExp[] = [
  /^$/,
  /<\/(?:script|pre|textarea|style)>/i,
  /-->/,
  /\?>/,
  />/,
  /\]\]>/,
];

const reThematicBreak = /^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:-[ \t]*){3,}$/;
/** Characters that can begin a block start; other lines skip the start checks. */
const reMaybeSpecial = /^[#`~*+_=<>0-9|:-]/;
const reNonSpace = /[^ \t\f\v\r\n]/;
const reBulletListMarker = /^[*+-]/;
const reOrderedListMarker = /^(\d{1,9})([.)])/;
const reATXHeadingMarker = /^#{1,6}(?:[ \t]+|$)/;
const reClosingCodeFence = /^(?:`{3,}|~{3,})(?=[ \t]*$)/;
const reSetextHeadingLine = /^(?:=+|-+)[ \t]*$/;
const reTableDelimiterCell = /^:?-+:?$/;
const reTaskMarker = /^\[([ \t\nxX])\](?:[ \t\n]+|$)/;

// ---------------------------------------------------------------------------
// Block nodes used while parsing

type BlockType =
  | 'document'
  | 'paragraph'
  | 'heading'
  | 'thematicBreak'
  | 'blockQuote'
  | 'list'
  | 'item'
  | 'codeBlock'
  | 'htmlBlock'
  | 'rawBlock'
  | 'table';

interface ListData {
  type: 'bullet' | 'ordered';
  bulletChar: string;
  start: number;
  delimiter: string;
  /** Column of the content relative to the marker start. */
  padding: number;
  /** Indentation of the marker. */
  markerOffset: number;
}

class BNode {
  parent: BNode | null = null;
  children: BNode[] = [];
  /** Number of ancestors. */
  depth = 0;
  open = true;
  endLine = 0;
  /** Raw text content of leaf blocks, one "\n"-terminated line at a time. */
  content = '';

  // Heading
  level = 0;
  setext = false;
  // Code block
  fenced = false;
  fenceChar = '';
  fenceLength = 0;
  fenceOffset = 0;
  info = '';
  // HTML block
  htmlType = 0;
  // Block of a syntax extension
  syntax = '';
  matcher: BlockSyntaxMatcher | null = null;
  // List and list item
  list: ListData | null = null;
  tight = true;
  // Table
  align: TableAlign[] = [];
  rows: string[][] = [];

  constructor(
    readonly type: BlockType,
    public startLine: number,
  ) {}

  get lastChild(): BNode | undefined {
    return this.children[this.children.length - 1];
  }

  append(child: BNode): void {
    child.parent = this;
    child.depth = this.depth + 1;
    this.children.push(child);
  }

  remove(): void {
    if (!this.parent) return;
    const siblings = this.parent.children;
    const i = siblings.lastIndexOf(this);
    if (i >= 0) siblings.splice(i, 1);
    this.parent = null;
  }
}

/** Result of trying to continue a block: matched, not matched, or the line was consumed. */
const enum Continue {
  Matched = 0,
  Failed = 1,
  LineDone = 2,
}

/** Result of a block start: no match, a container started, or a leaf started. */
const enum Start {
  None = 0,
  Container = 1,
  Leaf = 2,
}

function acceptsLines(type: BlockType): boolean {
  return type === 'paragraph' || type === 'codeBlock' || type === 'htmlBlock' || type === 'rawBlock';
}

function canContain(parent: BlockType, child: BlockType): boolean {
  switch (parent) {
    case 'document':
    case 'blockQuote':
    case 'item':
      return child !== 'item';
    case 'list':
      return child === 'item';
    default:
      return false;
  }
}

function isSpaceOrTab(c: string | undefined): boolean {
  return c === ' ' || c === '\t';
}

// ---------------------------------------------------------------------------
// Parser

class BlockParser {
  private doc = new BNode('document', 1);
  private tip: BNode = this.doc;
  private oldTip: BNode = this.doc;
  private lastMatchedContainer: BNode = this.doc;
  private refs: RefMap = new Map();
  private definitions: string[] = [];
  /** Empty cells added to short table rows so far, and how many the document may have. */
  private filledCells = 0;
  private maxFilledCells = 0;

  constructor(private readonly options: ResolvedMarkdown) {}

  // State for the current line.
  private line = '';
  private lineNumber = 0;
  private offset = 0;
  private column = 0;
  private nextNonspace = 0;
  private nextNonspaceColumn = 0;
  private indent = 0;
  private indented = false;
  private blank = false;
  private partiallyConsumedTab = false;
  private allClosed = true;

  parse(src: string): Root {
    // A byte order mark is not text, as in cmark. The first line keeps its number.
    const lines = (src.charCodeAt(0) === 0xfeff ? src.slice(1) : src).split(/\r\n|\n|\r/);
    this.maxFilledCells = Math.max(MIN_FILLED_CELLS, src.length);
    let count = lines.length;
    // A final line ending does not start another (empty) line.
    if (src.endsWith('\n') || src.endsWith('\r')) count -= 1;
    for (let i = 0; i < count; i++) this.incorporateLine(lines[i]!);
    while (this.tip !== this.doc) this.finalize(this.tip, count);
    this.finalize(this.doc, count);
    const children: BlockNode[] = [];
    const sourceLines: SourceLines[] = [];
    for (const child of this.doc.children) {
      for (const node of this.toAst(child)) {
        children.push(node);
        sourceLines.push({ start: child.startLine, end: child.endLine });
      }
    }
    return { type: 'root', children, lines: sourceLines, definitions: this.definitions };
  }

  /** Link reference definitions at the start of a paragraph's content. Keeps their source. */
  private extractReferences(content: string): string {
    const rest = extractReferences(content, this.refs);
    if (rest.length < content.length) this.definitions.push(content.slice(0, content.length - rest.length).replace(/\n$/, ''));
    return rest;
  }

  // -- Line position helpers ------------------------------------------------

  private findNextNonspace(): void {
    const line = this.line;
    let i = this.offset;
    let cols = this.column;
    let c: string | undefined;
    while ((c = line[i]) !== undefined) {
      if (c === ' ') {
        i++;
        cols++;
      } else if (c === '\t') {
        i++;
        cols += 4 - (cols % 4);
      } else {
        break;
      }
    }
    this.blank = c === undefined;
    this.nextNonspace = i;
    this.nextNonspaceColumn = cols;
    this.indent = cols - this.column;
    this.indented = this.indent >= CODE_INDENT;
  }

  private advanceNextNonspace(): void {
    this.offset = this.nextNonspace;
    this.column = this.nextNonspaceColumn;
    this.partiallyConsumedTab = false;
  }

  /**
   * Advances by `count` characters, or by `count` columns if `columns` is
   * set. A tab advanced by columns may be only partly consumed.
   */
  private advanceOffset(count: number, columns: boolean): void {
    const line = this.line;
    let c: string | undefined;
    while (count > 0 && (c = line[this.offset]) !== undefined) {
      if (c === '\t') {
        const toTab = 4 - (this.column % 4);
        if (columns) {
          this.partiallyConsumedTab = toTab > count;
          const advance = toTab > count ? count : toTab;
          this.column += advance;
          this.offset += this.partiallyConsumedTab ? 0 : 1;
          count -= advance;
        } else {
          this.partiallyConsumedTab = false;
          this.column += toTab;
          this.offset += 1;
          count -= 1;
        }
      } else {
        this.partiallyConsumedTab = false;
        this.offset += 1;
        this.column += 1;
        count -= 1;
      }
    }
  }

  // -- Tree helpers ---------------------------------------------------------

  private addLine(): void {
    if (this.partiallyConsumedTab) {
      // Skip the tab and add the columns it still covers as spaces.
      this.offset += 1;
      this.tip.content += ' '.repeat(4 - (this.column % 4));
    }
    this.tip.content += this.line.slice(this.offset) + '\n';
  }

  private addChild(type: BlockType): BNode {
    while (!canContain(this.tip.type, type)) this.finalize(this.tip, this.lineNumber - 1);
    const node = new BNode(type, this.lineNumber);
    this.tip.append(node);
    this.tip = node;
    return node;
  }

  private closeUnmatchedBlocks(): void {
    if (this.allClosed) return;
    while (this.oldTip !== this.lastMatchedContainer) {
      const parent = this.oldTip.parent!;
      this.finalize(this.oldTip, this.lineNumber - 1);
      this.oldTip = parent;
    }
    this.allClosed = true;
  }

  // -- Main loop ------------------------------------------------------------

  private incorporateLine(rawLine: string): void {
    let container = this.doc;
    this.oldTip = this.tip;
    this.offset = 0;
    this.column = 0;
    this.blank = false;
    this.partiallyConsumedTab = false;
    this.lineNumber += 1;
    // NUL characters are replaced for security (spec section 2.3).
    this.line = rawLine.includes('\0') ? rawLine.replace(/\0/g, '\uFFFD') : rawLine;

    // 1. Match the line against the open blocks, outermost first.
    let last: BNode | undefined;
    while ((last = container.lastChild) && last.open) {
      container = last;
      this.findNextNonspace();
      const result = this.continueBlock(container);
      if (result === Continue.LineDone) return;
      if (result === Continue.Failed) {
        container = container.parent!;
        break;
      }
    }
    this.allClosed = container === this.oldTip;
    this.lastMatchedContainer = container;

    // 2. Look for new block starts, unless the container takes raw lines.
    let matchedLeaf = container.type !== 'paragraph' && acceptsLines(container.type);
    while (!matchedLeaf) {
      this.findNextNonspace();
      // Lines that cannot start a block skip the start checks; with block
      // syntax extensions, any line might.
      if (!this.indented && this.options.block.length === 0 && !reMaybeSpecial.test(this.line.charAt(this.nextNonspace))) {
        this.advanceNextNonspace();
        break;
      }
      const result = this.tryStarts(container);
      if (result === Start.None) {
        this.advanceNextNonspace();
        break;
      }
      container = this.tip;
      if (result === Start.Leaf) matchedLeaf = true;
    }

    // 3. Add the rest of the line to the right block.
    if (!this.allClosed && !this.blank && this.tip.type === 'paragraph') {
      // Lazy paragraph continuation.
      this.addLine();
    } else {
      this.closeUnmatchedBlocks();
      const type = container.type;
      if (acceptsLines(type)) {
        this.addLine();
        if (
          type === 'htmlBlock' &&
          container.htmlType >= 1 &&
          container.htmlType <= 5 &&
          reHtmlBlockClose[container.htmlType]!.test(this.line.slice(this.offset))
        ) {
          this.finalize(container, this.lineNumber);
        }
      } else if (type === 'table') {
        if (!this.blank && this.offset < this.line.length) {
          const cells = splitRow(this.line.slice(this.offset));
          const filled = Math.max(0, container.align.length - cells.length);
          if (this.filledCells + filled <= this.maxFilledCells) {
            this.filledCells += filled;
            container.rows.push(fitRow(cells, container.align.length));
          } else {
            // Too many empty cells to fill: the table ends and the row is text.
            this.finalize(container, this.lineNumber - 1);
            this.addChild('paragraph');
            this.advanceNextNonspace();
            this.addLine();
          }
        }
      } else if (this.offset < this.line.length && !this.blank) {
        this.addChild('paragraph');
        this.advanceNextNonspace();
        this.addLine();
      }
    }
  }

  private continueBlock(block: BNode): Continue {
    const line = this.line;
    switch (block.type) {
      case 'document':
      case 'list':
        return Continue.Matched;
      case 'blockQuote':
        if (!this.indented && line[this.nextNonspace] === '>') {
          this.advanceNextNonspace();
          this.advanceOffset(1, false);
          if (isSpaceOrTab(line[this.offset])) this.advanceOffset(1, true);
          return Continue.Matched;
        }
        return Continue.Failed;
      case 'item': {
        const data = block.list!;
        if (this.blank) {
          // An item can begin with at most one blank line.
          if (block.children.length === 0) return Continue.Failed;
          // Spaces past the item's content column stay, for a fenced code block's blank line.
          this.advanceOffset(Math.min(this.indent, data.markerOffset + data.padding), true);
        } else if (this.indent >= data.markerOffset + data.padding) {
          this.advanceOffset(data.markerOffset + data.padding, true);
        } else {
          return Continue.Failed;
        }
        return Continue.Matched;
      }
      case 'heading':
      case 'thematicBreak':
        // Single-line blocks.
        return Continue.Failed;
      case 'codeBlock':
        if (block.fenced) {
          const m =
            this.indent <= 3 && line[this.nextNonspace] === block.fenceChar
              ? reClosingCodeFence.exec(line.slice(this.nextNonspace))
              : null;
          if (m && m[0].length >= block.fenceLength) {
            this.finalize(block, this.lineNumber);
            return Continue.LineDone;
          }
          // Skip the optional indentation of the opening fence.
          let i = block.fenceOffset;
          while (i > 0 && isSpaceOrTab(line[this.offset])) {
            this.advanceOffset(1, true);
            i--;
          }
          return Continue.Matched;
        }
        if (this.indent >= CODE_INDENT) {
          this.advanceOffset(CODE_INDENT, true);
        } else if (this.blank) {
          this.advanceNextNonspace();
        } else {
          return Continue.Failed;
        }
        return Continue.Matched;
      case 'htmlBlock':
        return this.blank && (block.htmlType === 6 || block.htmlType === 7) ? Continue.Failed : Continue.Matched;
      case 'rawBlock': {
        const next = block.matcher!.next(line.slice(this.offset));
        if (next === 'end') return Continue.Failed;
        if (next === 'close') {
          this.addLine();
          this.finalize(block, this.lineNumber);
          return Continue.LineDone;
        }
        return Continue.Matched;
      }
      case 'paragraph':
      case 'table':
        return this.blank ? Continue.Failed : Continue.Matched;
    }
  }

  private finalize(block: BNode, lineNumber: number): void {
    const parent = block.parent;
    block.open = false;
    block.endLine = lineNumber;

    switch (block.type) {
      case 'paragraph':
        block.content = this.extractReferences(block.content);
        if (!reNonSpace.test(block.content)) block.remove();
        break;
      case 'codeBlock':
        if (block.fenced) {
          // The first line is the info string.
          const nl = block.content.indexOf('\n');
          block.info = unescapeString(block.content.slice(0, nl).trim());
          block.content = block.content.slice(nl + 1);
        } else {
          // Trailing blank lines are not part of an indented code block.
          const lines = block.content.split('\n');
          while (lines.length > 0 && /^[ \t]*$/.test(lines[lines.length - 1]!)) lines.pop();
          block.content = lines.join('\n') + '\n';
          block.endLine = block.startLine + lines.length - 1;
        }
        break;
      case 'htmlBlock':
        block.content = block.content.replace(/(\n *)+$/, '');
        break;
      case 'rawBlock': {
        // Trailing blank lines a matcher continued through are not part of the
        // block, as with an indented code block: a footnote definition keeps a
        // blank line only before an indented continuation.
        const lines = block.content.replace(/\n$/, '').split('\n');
        while (lines.length > 1 && /^[ \t]*$/.test(lines[lines.length - 1]!)) lines.pop();
        block.content = lines.join('\n');
        block.endLine = block.startLine + lines.length - 1;
        break;
      }
      case 'item':
        block.endLine = block.lastChild ? block.lastChild.endLine : block.startLine;
        break;
      case 'list':
        block.tight = isTight(block);
        if (block.lastChild) block.endLine = block.lastChild.endLine;
        break;
      default:
        break;
    }
    this.tip = parent ?? this.doc;
  }

  // -- Block starts ---------------------------------------------------------

  /** Tries the block starts in order. `rest` is the line from the next non-space character. */
  private tryStarts(container: BNode): Start {
    const rest = this.line.slice(this.nextNonspace);
    const nest = container.depth < MAX_NESTING;
    return (
      (nest && this.startBlockQuote(rest)) ||
      this.startAtxHeading(rest) ||
      this.startSyntaxBlock(container, rest) ||
      this.startFencedCode(rest) ||
      this.startHtmlBlock(container, rest) ||
      this.startSetextHeading(container, rest) ||
      this.startThematicBreak(rest) ||
      (nest && this.startListItem(container, rest)) ||
      this.startTable(container, rest) ||
      this.startIndentedCode()
    );
  }

  private startBlockQuote(rest: string): Start {
    if (this.indented || rest[0] !== '>') return Start.None;
    this.advanceNextNonspace();
    this.advanceOffset(1, false);
    if (isSpaceOrTab(this.line[this.offset])) this.advanceOffset(1, true);
    this.closeUnmatchedBlocks();
    this.addChild('blockQuote');
    return Start.Container;
  }

  private startAtxHeading(rest: string): Start {
    if (this.indented || rest[0] !== '#') return Start.None;
    const m = reATXHeadingMarker.exec(rest);
    if (!m) return Start.None;
    this.advanceNextNonspace();
    this.advanceOffset(m[0].length, false);
    this.closeUnmatchedBlocks();
    const heading = this.addChild('heading');
    heading.level = m[0].trim().length;
    // Remove the optional closing sequence.
    heading.content = this.line
      .slice(this.offset)
      .replace(/^[ \t]*#+[ \t]*$/, '')
      .replace(/[ \t]+#+[ \t]*$/, '');
    this.advanceOffset(this.line.length - this.offset, false);
    return Start.Leaf;
  }

  /** Whether a new block would interrupt a paragraph, including a lazy continuation line. */
  private inParagraph(container: BNode): boolean {
    return container.type === 'paragraph' || (!this.allClosed && !this.blank && this.tip.type === 'paragraph');
  }

  /** A block of a syntax extension. Like an HTML block, its indentation is part of it. */
  private startSyntaxBlock(container: BNode, rest: string): Start {
    if (this.indented || this.options.block.length === 0) return Start.None;
    const inParagraph = this.inParagraph(container);
    for (const syntax of this.options.block) {
      if (inParagraph && !syntax.interruptsParagraph) continue;
      const matcher = syntax.open(rest);
      if (!matcher) continue;
      this.closeUnmatchedBlocks();
      const block = this.addChild('rawBlock');
      block.syntax = syntax.name;
      block.matcher = matcher;
      return Start.Leaf;
    }
    return Start.None;
  }

  private startFencedCode(rest: string): Start {
    const ch = rest[0];
    if (this.indented || (ch !== '`' && ch !== '~')) return Start.None;
    let length = 1;
    while (rest[length] === ch) length++;
    // The info string of a backtick fence may not contain backticks.
    if (length < 3 || (ch === '`' && rest.includes('`', length))) return Start.None;
    this.closeUnmatchedBlocks();
    const code = this.addChild('codeBlock');
    code.fenced = true;
    code.fenceLength = length;
    code.fenceChar = ch;
    code.fenceOffset = this.indent;
    this.advanceNextNonspace();
    this.advanceOffset(length, false);
    return Start.Leaf;
  }

  private startHtmlBlock(container: BNode, s: string): Start {
    if (this.indented || s[0] !== '<') return Start.None;
    // Type 7 cannot interrupt a paragraph (not even a lazy one).
    const inParagraph = this.inParagraph(container);
    for (let type = 1; type <= 7; type++) {
      if (reHtmlBlockOpen[type]!.test(s) && (type < 7 || !inParagraph)) {
        this.closeUnmatchedBlocks();
        // The indentation is part of the HTML block, so the offset stays.
        const block = this.addChild('htmlBlock');
        block.htmlType = type;
        return Start.Leaf;
      }
    }
    return Start.None;
  }

  private startSetextHeading(container: BNode, rest: string): Start {
    if (!this.options.setext || this.indented || container.type !== 'paragraph') return Start.None;
    const m = reSetextHeadingLine.exec(rest);
    if (!m) return Start.None;
    this.closeUnmatchedBlocks();
    // Link reference definitions are not heading content.
    container.content = this.extractReferences(container.content);
    if (container.content.length === 0) return Start.None;
    const heading = new BNode('heading', container.startLine);
    heading.level = m[0][0] === '=' ? 1 : 2;
    heading.setext = true;
    heading.content = container.content;
    const parent = container.parent!;
    parent.children[parent.children.lastIndexOf(container)] = heading;
    heading.parent = parent;
    container.parent = null;
    this.tip = heading;
    this.advanceOffset(this.line.length - this.offset, false);
    return Start.Leaf;
  }

  /**
   * GFM table: a delimiter row (`| --- | :-: |`) under a paragraph whose last
   * line has the same number of cells. That line becomes the header row; any
   * earlier lines stay a paragraph. As in cmark-gfm, it is tried after setext
   * underlines, thematic breaks and list items, so `- |` is a list item and
   * `:-:` with no pipe is a delimiter row. Without setext headings, a setext
   * underline (`-`) stays paragraph text rather than making a table.
   */
  private startTable(container: BNode, rest: string): Start {
    if (this.indented || container.type !== 'paragraph') return Start.None;
    if (!rest.includes('|') && reSetextHeadingLine.test(rest)) return Start.None;
    const align = parseDelimiterRow(rest);
    if (!align) return Start.None;

    container.content = this.extractReferences(container.content);
    const lines = container.content.split('\n');
    lines.pop(); // the content ends with "\n"
    const headerLine = lines.pop();
    if (headerLine === undefined) return Start.None;
    const header = splitRow(headerLine);
    if (header.length !== align.length) return Start.None;

    this.closeUnmatchedBlocks();
    const parent = container.parent!;
    if (lines.length > 0) {
      container.content = lines.join('\n') + '\n';
      // The paragraph ends before the header row.
      this.finalize(container, this.lineNumber - 2);
    } else {
      container.remove();
      this.tip = parent;
    }
    const table = this.addChild('table');
    // The header row is the line before the delimiter row.
    table.startLine = this.lineNumber - 1;
    table.align = align;
    table.rows.push(header);
    this.advanceOffset(this.line.length - this.offset, false);
    return Start.Leaf;
  }

  private startThematicBreak(rest: string): Start {
    if (this.indented || !reThematicBreak.test(rest)) return Start.None;
    this.closeUnmatchedBlocks();
    this.addChild('thematicBreak');
    this.advanceOffset(this.line.length - this.offset, false);
    return Start.Leaf;
  }

  private startListItem(container: BNode, rest: string): Start {
    if (this.indented && container.type !== 'list') return Start.None;
    const data = this.parseListMarker(container, rest);
    if (!data) return Start.None;
    this.closeUnmatchedBlocks();
    if (this.tip.type !== 'list' || !listsMatch(container.list, data)) {
      const list = this.addChild('list');
      list.list = data;
    }
    const item = this.addChild('item');
    item.list = data;
    return Start.Container;
  }

  private startIndentedCode(): Start {
    if (!this.indented || this.tip.type === 'paragraph' || this.blank) return Start.None;
    this.advanceOffset(CODE_INDENT, true);
    this.closeUnmatchedBlocks();
    this.addChild('codeBlock');
    return Start.Leaf;
  }

  /** Parses a list marker and the spaces after it. Returns null if there is no list item here. */
  private parseListMarker(container: BNode, rest: string): ListData | null {
    if (this.indent >= 4) return null;
    const data: ListData = {
      type: 'bullet',
      bulletChar: '',
      start: 1,
      delimiter: '',
      padding: 0,
      markerOffset: this.indent,
    };
    let markerLength: number;
    const bullet = reBulletListMarker.exec(rest);
    const ordered = bullet ? null : reOrderedListMarker.exec(rest);
    if (bullet) {
      data.bulletChar = bullet[0];
      markerLength = 1;
    } else if (ordered && (container.type !== 'paragraph' || parseInt(ordered[1]!, 10) === 1)) {
      // Only a list starting at 1 can interrupt a paragraph.
      data.type = 'ordered';
      data.start = parseInt(ordered[1]!, 10);
      data.delimiter = ordered[2]!;
      markerLength = ordered[0].length;
    } else {
      return null;
    }

    // The marker must be followed by a space, a tab or the end of the line.
    const next = this.line[this.nextNonspace + markerLength];
    if (next !== undefined && next !== ' ' && next !== '\t') return null;
    // An empty item cannot interrupt a paragraph.
    if (container.type === 'paragraph' && !reNonSpace.test(this.line.slice(this.nextNonspace + markerLength))) {
      return null;
    }

    this.advanceNextNonspace();
    this.advanceOffset(markerLength, true);
    const spacesStartCol = this.column;
    const spacesStartOffset = this.offset;
    do {
      this.advanceOffset(1, true);
    } while (this.column - spacesStartCol < 5 && isSpaceOrTab(this.line[this.offset]));
    const blankItem = this.line[this.offset] === undefined;
    const spacesAfterMarker = this.column - spacesStartCol;
    if (spacesAfterMarker >= 5 || spacesAfterMarker < 1 || blankItem) {
      // Five or more spaces start an indented code block inside the item;
      // the content then begins one space after the marker.
      data.padding = markerLength + 1;
      this.column = spacesStartCol;
      this.offset = spacesStartOffset;
      if (isSpaceOrTab(this.line[this.offset])) this.advanceOffset(1, true);
    } else {
      data.padding = markerLength + spacesAfterMarker;
    }
    return data;
  }

  // -- Phase two: inline content --------------------------------------------

  private toAst(node: BNode): BlockNode[] {
    switch (node.type) {
      case 'paragraph':
        return [{ type: 'paragraph', children: parseInlines(trimContent(node.content), this.refs, this.options.inline, this.options.autolinks) }];
      case 'heading':
        return [
          {
            type: 'heading',
            level: node.level as 1 | 2 | 3 | 4 | 5 | 6,
            setext: node.setext,
            children: parseInlines(trimContent(node.content), this.refs, this.options.inline, this.options.autolinks),
          },
        ];
      case 'thematicBreak':
        return [{ type: 'thematicBreak' }];
      case 'codeBlock':
        return [{ type: 'codeBlock', fenced: node.fenced, info: node.info, value: node.content }];
      case 'htmlBlock':
        return [{ type: 'htmlBlock', value: node.content }];
      case 'rawBlock':
        return [{ type: 'raw', name: node.syntax, value: node.content }];
      case 'blockQuote':
        return [{ type: 'blockQuote', children: node.children.flatMap((c) => this.toAst(c)) }];
      case 'list': {
        const data = node.list!;
        return [
          {
            type: 'list',
            ordered: data.type === 'ordered',
            start: data.start,
            marker: data.type === 'ordered' ? data.delimiter : data.bulletChar,
            tight: node.tight,
            items: node.children.map((item) => this.itemToAst(item)),
          },
        ];
      }
      case 'table':
        return [
          {
            type: 'table',
            align: node.align,
            rows: node.rows.map((row) => row.map((cell) => parseInlines(cell, this.refs, this.options.inline, this.options.autolinks))),
          },
        ];
      default:
        return [];
    }
  }

  private itemToAst(item: BNode): ListItemNode {
    let task = false;
    let checked = false;
    const first = item.children[0];
    if (first?.type === 'paragraph') {
      // GFM task list item: the first paragraph starts with [x], [X] or a
      // whitespace character in brackets ([ ], a tab, or a line ending).
      const m = reTaskMarker.exec(first.content);
      if (m) {
        task = true;
        checked = m[1] === 'x' || m[1] === 'X';
        first.content = first.content.slice(m[0].length);
      }
    }
    const children = item.children
      .filter((c) => !(task && c === first && !reNonSpace.test(c.content)))
      .flatMap((c) => this.toAst(c));
    return { type: 'listItem', task, checked, children };
  }
}

// ---------------------------------------------------------------------------
// Helpers

/** A paragraph's raw content without leading and trailing whitespace. */
function trimContent(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isTrimmable(s.charCodeAt(start))) start++;
  while (end > start && isTrimmable(s.charCodeAt(end - 1))) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

function isTrimmable(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a;
}

function listsMatch(a: ListData | null, b: ListData): boolean {
  return a !== null && a.type === b.type && a.delimiter === b.delimiter && a.bulletChar === b.bulletChar;
}

/**
 * A list is loose if any of its items are separated by blank lines, or if
 * any item directly contains two blocks with a blank line between them. A
 * block is followed by a blank line if the next block does not start on the
 * line right after it ends.
 */
function isTight(list: BNode): boolean {
  const endsWithBlankLine = (block: BNode, next: BNode | undefined) =>
    next !== undefined && block.endLine !== next.startLine - 1;
  for (let i = 0; i < list.children.length; i++) {
    const item = list.children[i]!;
    if (endsWithBlankLine(item, list.children[i + 1])) return false;
    for (let j = 0; j < item.children.length; j++) {
      if (endsWithBlankLine(item.children[j]!, item.children[j + 1])) return false;
    }
  }
  return true;
}

/**
 * Splits a table row into cells. Leading and trailing pipes are optional,
 * and `\|` is a literal pipe (also inside code spans, as in GFM).
 */
function splitRow(line: string): string[] {
  const s = line.replace(/^[ \t]+|[ \t]+$/g, '');
  const cells: string[] = [];
  let cell = '';
  let endsWithPipe = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    endsWithPipe = false;
    if (c === '\\' && i + 1 < s.length) {
      cell += s[i + 1] === '|' ? '|' : c + s[i + 1];
      i++;
    } else if (c === '|') {
      cells.push(cell);
      cell = '';
      endsWithPipe = true;
    } else {
      cell += c;
    }
  }
  if (!endsWithPipe || cells.length === 0) cells.push(cell);
  // A leading pipe opens no cell: `|` alone is a row of none.
  if (s.startsWith('|')) cells.shift();
  return cells.map((c) => c.replace(/^[ \t]+|[ \t]+$/g, ''));
}

/** Pads a body row with empty cells or drops excess cells. */
function fitRow(cells: string[], length: number): string[] {
  const row = cells.slice(0, length);
  while (row.length < length) row.push('');
  return row;
}

function parseDelimiterRow(line: string): TableAlign[] | null {
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const align: TableAlign[] = [];
  for (const cell of cells) {
    if (!reTableDelimiterCell.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return align;
}
