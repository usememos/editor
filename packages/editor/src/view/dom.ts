// Rendering blocks to DOM, and mapping between DOM points and model positions.
//
// Every block element is a direct child of the editor root and carries
// `data-block-id`. Inside it, the element marked `data-content` holds the
// block's inline content; markers, checkboxes and other chrome sit outside it
// with contenteditable="false". In a table, each cell is its own content
// element, marked with `data-row` and `data-col`.

import {
  type Block,
  type Cell,
  type CalloutType,
  type CodeBlock,
  type Doc,
  type ImageAtom,
  type Inline,
  type Mark,
  type ParagraphBlock,
  type QuoteBlock,
  type Position,
  type Span,
  MARK_ORDER,
  ATOM_CHAR,
  imageBlockOffset,
  inlineLength,
  inlineText,
  isQuotable,
  quoteKind,
  sameQuote,
  sliceInline,
  sameLink,
  normalizeInline,
} from '../model';
import type { BlockView, ExtensionContext, SyntaxView } from '../extension';
import type { Labels } from '../labels';
import type { IconName } from '../icons';
import type { ThemeClasses } from '../theme';
import { type Decoration, decorationContext, sameDecorations, splitByDecorations } from '../decorations';
import { SLOT_MARKER, slotMarker, splitHtmlSection } from '../markdown/htmlSection';
import type { BlockNode, BlockQuoteNode, ListItemNode, ListNode } from '../markdown/ast';
import { parseAst } from '../markdown/blocks';
import { calloutOf, lowerIfFits } from '../markdown/lower';
import { DEFAULT_MARKDOWN, type MarkdownOptions } from '../markdown/options';

export const BLOCK_ATTR = 'data-block-id';

/** The view name for code blocks of a language: `code:mermaid`. */
export function codeViewName(language: string): string {
  return `code:${language.trim().toLowerCase()}`;
}
const CONTENT_ATTR = 'data-content';
/** Source mode's content element, and its line elements (see "Source mode's text" below). */
const SOURCE_TEXT = 'mbe-source-text';
const SOURCE_LINE = 'mbe-source-line';
const FILL_ATTR = 'data-mbe-fill';
/** On a view's element while the promise it returned is pending; its slots are filled when it settles. */
const PENDING_ATTR = 'data-mbe-pending';
const ATOM_ATTR = 'data-atom';
const LIST_START_ATTR = 'data-list-start';
const QUOTE_JOINED_ATTR = 'data-quote-joined';
const QUOTE_CONTINUED_ATTR = 'data-quote-continued';
const SECTION_HIDDEN_ATTR = 'data-section-hidden';
const SECTION_COLLAPSED_ATTR = 'data-collapsed';
const SECTION_INSIDE_ATTR = 'data-in-section';

const MARK_TAGS: Record<Mark, [string, string?]> = {
  bold: ['strong'],
  italic: ['em'],
  strike: ['s'],
  code: ['code'],
  html: ['span', 'mbe-raw-html'],
};

const NO_CLASSES: ThemeClasses = {};

/** Joins class strings, skipping empty ones. */
function classes(...names: (string | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/** The theme's classes for a block's element. A block in a quote is a blockquote too, so it takes the quote's class as well. */
function blockClasses(block: Block, theme: ThemeClasses): string | undefined {
  const own = ownClasses(block, theme);
  return isQuotable(block) && block.quote ? classes(own, theme.blockquote) || undefined : own;
}

function ownClasses(block: Block, theme: ThemeClasses): string | undefined {
  switch (block.type) {
    case 'paragraph':
      return theme.paragraph;
    case 'heading':
      return theme.heading?.[block.level];
    case 'quote':
      return theme.blockquote;
    case 'listItem':
      return theme[`${block.listType}List`];
    case 'code':
      return theme.codeBlock;
    case 'table':
      return theme.table;
    case 'raw':
      return theme.raw;
    case 'divider':
      return undefined; // on the <hr>
    case 'details':
      return theme.details;
    case 'detailsEnd':
      return undefined;
  }
}

/** What a URL in the document is used for. */
export type UrlKind = 'link' | 'image';

/** Maps a link or image URL from the document to the URL to use, or null to drop it. The saved Markdown keeps the original. */
export type ResolveUrl = (url: string, kind: UrlKind) => string | null;

/**
 * The default URL policy: relative URLs and fragments, and the schemes
 * `http`, `https`, `mailto` and `tel`. Other URLs (`javascript:`, `data:`)
 * are kept in the model but not used. Apps that allow more can call this
 * for everything else.
 */
export const defaultResolveUrl: ResolveUrl = (url) => {
  // Read as a browser reads it (the WHATWG URL parser): without leading and
  // trailing control characters and spaces, or any tab or line break. Else
  // `java\tscript:` passes as relative and runs as `javascript:`.
  const read = url.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(read);
  if (!scheme) return read; // relative URL or fragment
  return ['http', 'https', 'mailto', 'tel'].includes(scheme[1]!.toLowerCase()) ? read : null;
};

/** What rendering needs besides the block. */
export interface RenderContext {
  readonly doc: Document;
  readonly labels: Labels;
  readonly resolveUrl: ResolveUrl;
  /** `referrerpolicy` for images. */
  readonly referrerPolicy?: ReferrerPolicy;
  /** Decorations for a text container. */
  readonly decorate?: (block: Block, content: Inline, cell?: Cell) => readonly Decoration[];
  /** Decorations for a code block's code, such as syntax highlighting. */
  readonly decorateCode?: (block: CodeBlock) => readonly Decoration[];
  /** Decorations for source mode's one block: the Markdown's highlighting, and the extensions' decorations over its text. */
  readonly decorateSource?: (block: CodeBlock) => readonly Decoration[];
  /** Syntaxes that have a view. */
  readonly views?: ReadonlyMap<string, SyntaxView>;
  /** A token or raw block of an extension syntax, rendered; null shows its source. */
  readonly view?: (syntax: string, source: string, kind: 'inline' | 'block') => HTMLElement | null;
  /**
   * The element an extension's block view draws a block of the document
   * into, in place of the block, or null for none (see `BlockView`). A view
   * placed after its block draws the block as usual: the renderer places
   * its element itself.
   */
  readonly blockView?: (block: Block) => HTMLElement | null;
  /** The document's Markdown options, for the Markdown inside an HTML section. */
  readonly markdown?: MarkdownOptions;
  /** Theme classes for rendered elements. */
  readonly classes: ThemeClasses;
  /** The icon of a UI control, or null for none. */
  readonly icon?: (name: IconName) => Node | null;
  /** Code blocks get a copy button. */
  readonly codeCopy?: boolean;
  /** The document is source mode's one code block: render it as plain text. */
  readonly source?: boolean;
  /** An image failed to load and its element was replaced by the unavailable state. */
  readonly onImageError?: () => void;
  /** A loaded image element with this `src` from the elements being replaced, to show again instead of a new one. */
  readonly loadedImage?: (src: string) => HTMLImageElement | undefined;
}

/**
 * Which views of one block show their source: `REVEAL_BLOCK` for a whole raw
 * block, or `tokenKey(cell, from)` for a token.
 */
export type BlockReveal = ReadonlySet<string>;
export const REVEAL_BLOCK = 'block';

export function tokenKey(cell: Cell | undefined, from: number): string {
  return cell ? `${cell.row}:${cell.col}@${from}` : `@${from}`;
}

export function sameReveal(a: BlockReveal | undefined, b: BlockReveal | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

/** The label and icon name of a callout type, such as `calloutNote`. */
export function calloutName(type: CalloutType): `callout${Capitalize<CalloutType>}` {
  return `callout${type[0]!.toUpperCase()}${type.slice(1)}` as `callout${Capitalize<CalloutType>}`;
}

/** Marks a paragraph that holds only an image (see `imageBlockOffset`), with the image's alignment. */
function markImageBlock(el: HTMLElement, block: ParagraphBlock): void {
  const offset = imageBlockOffset(block);
  if (offset === null) return;
  el.classList.add('mbe-image-block');
  const align = sliceInline(block.content, offset, offset + 1)[0]?.image?.align;
  if (align) el.dataset.align = align;
}

/**
 * A callout: the type's icon in the start column, then the text. The icon
 * shows on the first block of a callout only (see updateNeighborMarks); the
 * type's name is its accessible label.
 */
function renderCallout(block: QuoteBlock, type: CalloutType, ctx: RenderContext, reveal?: BlockReveal): HTMLElement {
  const doc = ctx.doc;
  const root = doc.createElement('blockquote');
  root.dir = 'auto';
  root.dataset.callout = type;
  const content = doc.createElement('div');
  content.className = 'mbe-content';
  fillContent(content, block.content, ctx, block, reveal);
  root.append(calloutIcon(type, ctx), content);
  return root;
}

/** A callout's icon, labelled with the type's name. */
function calloutIcon(type: CalloutType, ctx: RenderContext): HTMLElement {
  const name = calloutName(type);
  const icon = ctx.doc.createElement('div');
  icon.className = 'mbe-callout-icon';
  icon.contentEditable = 'false';
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', ctx.labels[name]);
  const glyph = ctx.icon?.(name);
  if (glyph) icon.appendChild(glyph);
  return icon;
}

function renderBlock(block: Block, ctx: RenderContext, reveal?: BlockReveal): HTMLElement {
  const { doc, labels } = ctx;
  const el = (tag: string, className?: string) => {
    const e = doc.createElement(tag);
    if (className) e.className = className;
    return e;
  };
  let root: HTMLElement;
  // Drawn by an extension's block view, unless the selection is in the block.
  const hosted = reveal?.has(REVEAL_BLOCK) || ctx.source ? null : ctx.blockView?.(block);
  if (hosted) {
    root = el('div', 'mbe-view-block mbe-block-view');
    root.contentEditable = 'false';
    root.appendChild(hosted);
  } else switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'quote':
      if (block.type === 'quote' && block.callout) {
        root = renderCallout(block, block.callout, ctx, reveal);
        break;
      }
      root = el(block.type === 'paragraph' ? 'p' : block.type === 'quote' ? 'blockquote' : `h${block.level}`);
      root.dir = 'auto';
      fillContent(root, block.content, ctx, block, reveal);
      if (block.type === 'paragraph') markImageBlock(root, block);
      break;
    case 'listItem': {
      // An item in a quote is a blockquote too, so it takes the quote's or callout's look.
      root = el(block.quote ? 'blockquote' : 'div');
      if (block.callout) {
        root.dataset.callout = block.callout;
        root.appendChild(calloutIcon(block.callout, ctx));
      }
      // The marker has no letters, so the item's text decides the side it sits on.
      root.dir = 'auto';
      root.dataset.listType = block.listType;
      root.dataset.indent = String(block.indent);
      const marker = el('span', 'mbe-marker');
      marker.contentEditable = 'false';
      if (block.listType === 'task') {
        const box = el('input', 'mbe-checkbox') as HTMLInputElement;
        box.type = 'checkbox';
        box.tabIndex = -1;
        box.checked = block.checked;
        marker.appendChild(box);
      }
      const content = el('div', 'mbe-content');
      fillContent(content, block.content, ctx, block, reveal);
      root.append(marker, content);
      break;
    }
    case 'code': {
      if (ctx.source) {
        // Source mode: the whole document as text, one element per line, with no bar or view; `decorateSource` highlights it.
        // Each line sets its own direction: `dir="auto"` on the block would make Chrome resolve it again on every
        // line inserted, which takes a second for a 100 KB document.
        root = el('div');
        root.spellcheck = false;
        const text = el('div', SOURCE_TEXT);
        text.setAttribute(CONTENT_ATTR, '');
        fillSource(text, block, ctx);
        root.appendChild(text);
        break;
      }
      // Rendered by a view of its language, such as a diagram, unless the selection is in it.
      const view = reveal?.has(REVEAL_BLOCK) ? null : ctx.view?.(codeViewName(block.language), inlineText(block.content), 'block');
      if (view) {
        root = view;
        root.classList.add('mbe-view-block');
        root.contentEditable = 'false';
        root.dataset.language = block.language;
        break;
      }
      root = el('div');
      root.dataset.language = block.language;
      const bar = el('div', 'mbe-code-bar');
      bar.contentEditable = 'false';
      const lang = el('input', 'mbe-code-lang') as HTMLInputElement;
      lang.value = block.language;
      lang.spellcheck = false;
      lang.setAttribute('aria-label', labels.language);
      lang.placeholder = labels.plainText;
      bar.appendChild(lang);
      if (ctx.codeCopy) bar.appendChild(copyButton(ctx));
      const pre = el('pre');
      const code = el('code');
      code.spellcheck = false;
      fillContent(code, block.content, ctx, block, undefined, undefined, false);
      pre.appendChild(code);
      root.append(bar, pre);
      break;
    }
    case 'raw': {
      // Rendered, for example math as a formula, unless the selection is in the block.
      // An HTML section renders its HTML through the sanitizer (the `html` view) and the Markdown between its tags as blocks.
      // A footnote definition renders its label through the view and its text as inline Markdown.
      const source = inlineText(block.content);
      const revealed = reveal?.has(REVEAL_BLOCK) === true;
      const section = block.syntax === 'html' && !revealed && ctx.views?.has('html') ? splitHtmlSection(source, ctx.markdown) : null;
      const footnote = block.syntax === 'footnote' && !revealed && ctx.views?.has('footnote') ? splitFootnote(source) : null;
      const nested = block.syntax === 'markdown' && !revealed && ctx.views?.get('markdown') === MARKDOWN_VIEW;
      const view = revealed
        ? null
        : nested
          ? renderMarkdown(source, ctx)
          : footnote
            ? renderFootnote(footnote, ctx)
            : ctx.view?.(block.syntax, section ? section.html : source, 'block');
      if (view) {
        root = view;
        root.classList.add('mbe-view-block');
        if (block.syntax === 'html') root.classList.add('mbe-view-html');
        root.contentEditable = 'false';
        if (section) fillSlots(root, section.slots.length, (i) => renderFlow(section.slots[i]!, ctx), ctx.doc);
      } else {
        root = el('pre');
        root.spellcheck = false;
        fillContent(root, block.content, ctx, block, undefined, undefined, false);
      }
      root.dataset.syntax = block.syntax;
      break;
    }
    case 'divider':
      root = el('div');
      root.contentEditable = 'false';
      root.appendChild(el('hr', ctx.classes.divider));
      break;
    case 'details': {
      // The toggle, then the title. Whether the section is collapsed is set by updateNeighborMarks.
      root = el('div');
      root.dir = 'auto';
      const marker = el('span', 'mbe-details-marker');
      marker.contentEditable = 'false';
      const toggle = el('button', 'mbe-details-toggle');
      (toggle as HTMLButtonElement).type = 'button';
      toggle.tabIndex = -1;
      const icon = ctx.icon?.('chevronRight');
      if (icon) toggle.appendChild(icon);
      marker.appendChild(toggle);
      const content = el('div', 'mbe-content');
      fillContent(content, block.content, ctx, block, undefined, undefined, false);
      root.append(marker, content);
      break;
    }
    case 'detailsEnd':
      // Holds no text: where the section ends.
      root = el('div');
      root.contentEditable = 'false';
      break;
    case 'table': {
      root = el('div');
      root.contentEditable = 'false';
      const tableEl = el('table');
      const tbody = el('tbody');
      block.rows.forEach((row, r) => {
        const tr = el('tr');
        row.forEach((cell, c) => {
          const td = el(r === 0 ? 'th' : 'td');
          td.contentEditable = 'true';
          td.dir = 'auto';
          td.dataset.row = String(r);
          td.dataset.col = String(c);
          const align = block.align[c];
          if (align) td.style.textAlign = align;
          fillContent(td, cell, ctx, block, reveal, { row: r, col: c });
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      tableEl.appendChild(tbody);
      root.appendChild(tableEl);
      break;
    }
  }
  // A heading, code block, raw block, divider or table in a quote is a
  // blockquote holding the block's usual element as its content, as a quoted
  // list item is one holding the item's marker and text. The quote's rules
  // style the blockquote; the element inside keeps the block's own.
  if (!hosted && !ctx.source && block.type !== 'listItem' && isQuotable(block) && block.quote) {
    const inner = root;
    root = el('blockquote');
    if (block.type === 'heading') root.dir = 'auto';
    if (block.callout) {
      root.dataset.callout = block.callout;
      root.appendChild(calloutIcon(block.callout, ctx));
    }
    inner.classList.add('mbe-content');
    if (inner.contentEditable === 'false') root.contentEditable = 'false';
    if (inner.classList.contains('mbe-view-block')) root.classList.add('mbe-view-block');
    for (const key of ['language', 'syntax'] as const) if (inner.dataset[key] !== undefined) root.dataset[key] = inner.dataset[key];
    root.appendChild(inner);
  }
  root.setAttribute(BLOCK_ATTR, block.id);
  // One className write instead of several classList calls: this runs for every block on load.
  const name =
    block.type === 'listItem' ? 'list-item' : block.type === 'detailsEnd' ? 'details-end' : block.type === 'code' && ctx.source ? 'source' : block.type;
  let className = `${root.className ? root.className + ' ' : ''}mbe-block mbe-${name}`;
  if (block.type === 'listItem' && block.checked) className += ' mbe-checked';
  if ('content' in block && inlineLength(block.content) === 0) className += ' mbe-empty';
  const themed = blockClasses(block, ctx.classes);
  if (themed) className += ' ' + themed;
  root.className = className;
  return root;
}

// Source mode's text is one block element per line, without the line
// endings: the text's "\n" is the boundary between two lines. A keystroke
// then replaces one line's element, and the browser lays out only that line,
// not the whole document. An empty line holds a filler <br> for its height.

/** Per source text element, the lines rendered in it, to find the ones that changed. */
const sourceLines = new WeakMap<HTMLElement, readonly SourceLine[]>();

interface SourceLine {
  readonly text: string;
  /** The decorations on the line, with offsets in the line's text. */
  readonly decorations: readonly Decoration[];
}

const NO_DECORATIONS: readonly Decoration[] = [];

/** The text's lines and the decorations that reach into each, in the order given. */
function splitSourceLines(text: string, decorations: readonly Decoration[]): SourceLine[] {
  const sorted = decorations.map((d, index) => ({ d, index })).filter((e) => e.d.to > e.d.from).sort((a, b) => a.d.from - b.d.from);
  let next = 0;
  let carry: { d: Decoration; index: number }[] = [];
  const lines: SourceLine[] = [];
  for (let start = 0; ; ) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    const here = carry.filter((e) => e.d.to > start);
    while (next < sorted.length && sorted[next]!.d.from < end) {
      const e = sorted[next++]!;
      if (e.d.to > start) here.push(e);
    }
    carry = here.filter((e) => e.d.to > end);
    if (here.length > 1) here.sort((a, b) => a.index - b.index);
    const local = here.length === 0 ? NO_DECORATIONS : here.map(({ d }) => ({ ...d, from: Math.max(d.from, start) - start, to: Math.min(d.to, end) - start })).filter((d) => d.to > d.from);
    lines.push({ text: text.slice(start, end), decorations: local });
    if (nl === -1) return lines;
    start = nl + 1;
  }
}

function sameLine(a: SourceLine, b: SourceLine): boolean {
  return a.text === b.text && sameDecorations(a.decorations, b.decorations);
}

function isSourceLine(n: Node): n is HTMLElement {
  return n instanceof HTMLElement && n.classList.contains(SOURCE_LINE);
}

/** Source mode's line elements with their text lengths: from the lines as rendered, or from the elements when the browser changed them. */
function* sourceLineLengths(contentEl: HTMLElement): Generator<[HTMLElement, number]> {
  const rendered = sourceLines.get(contentEl);
  const cached = rendered && rendered.length === contentEl.childElementCount ? rendered : null;
  let i = 0;
  for (let n = contentEl.firstChild; n; n = n.nextSibling) {
    if (!isSourceLine(n)) continue;
    yield [n, cached ? cached[i]!.text.length : n.textContent!.length];
    i++;
  }
}

/** Renders source mode's text into its content element, or brings it up to date. */
function fillSource(content: HTMLElement, block: CodeBlock, ctx: RenderContext): void {
  patchSourceText(content, inlineText(block.content), ctx.decorateSource?.(block) ?? [], ctx);
}

/** A line of source mode's text: plain text split at the decorations' edges, each piece wrapped in its decorations. */
function renderSourceLine(line: SourceLine, ctx: RenderContext): HTMLElement {
  const doc = ctx.doc;
  const el = doc.createElement('div');
  el.className = SOURCE_LINE;
  el.dir = 'auto';
  if (line.text.length === 0) el.appendChild(fill(doc));
  else if (line.decorations.length === 0) el.appendChild(doc.createTextNode(line.text));
  else {
    for (const piece of splitByDecorations([{ text: line.text, marks: [] }], line.decorations)) {
      el.appendChild(decorate(doc.createTextNode(piece.span.text), piece.decorations, doc));
    }
  }
  return el;
}

/**
 * Renders source mode's text into its content element, or brings it up to
 * date: the lines whose text and decorations are the same keep their element,
 * and the run of lines between the unchanged ones at the start and the end
 * is rendered again.
 */
function patchSourceText(target: HTMLElement, text: string, decorations: readonly Decoration[], ctx: RenderContext): void {
  const lines = splitSourceLines(text, decorations);
  target.classList.toggle('mbe-empty-content', text.length === 0);
  const old = Array.from(target.childNodes).filter(isSourceLine);
  let prev = sourceLines.get(target) ?? [];
  if (old.length !== prev.length) {
    // The browser changed the structure: start over.
    prev = [];
    target.replaceChildren();
  }
  let a = 0;
  while (a < prev.length && a < lines.length && sameLine(prev[a]!, lines[a]!)) a++;
  let b = 0;
  while (b < prev.length - a && b < lines.length - a && sameLine(prev[prev.length - 1 - b]!, lines[lines.length - 1 - b]!)) b++;
  const fragment = ctx.doc.createDocumentFragment();
  for (let i = a; i < lines.length - b; i++) fragment.appendChild(renderSourceLine(lines[i]!, ctx));
  const ref = b > 0 ? old[prev.length - b]! : null;
  for (let i = a; i < prev.length - b; i++) old[i]!.remove();
  target.insertBefore(fragment, ref);
  // Nothing but the lines: the browser may have inserted something of its own.
  if (target.childNodes.length !== lines.length) {
    for (const n of Array.from(target.childNodes)) if (!isSourceLine(n)) n.remove();
  }
  sourceLines.set(target, lines);
}

/** The text of source mode's content element as the browser has it: the lines joined by line endings. */
function sourceDomText(contentEl: HTMLElement): string {
  const parts: string[] = [];
  let current = '';
  for (let n = contentEl.firstChild; n; n = n.nextSibling) {
    if (isSourceLine(n)) {
      if (n !== contentEl.firstChild) parts.push(current);
      current = leaves(n).map(leafText).join('');
    } else {
      // Something the browser put between the lines joins the line before it.
      current += n.nodeType === 3 ? (n as Text).data : (n as HTMLElement).hasAttribute(FILL_ATTR) ? '' : (n.textContent ?? '');
    }
  }
  parts.push(current);
  return parts.join('\n');
}

/** `decorated` is false for containers that take no decorations (code and raw blocks). */
function fillContent(
  target: HTMLElement,
  inline: Inline,
  ctx: RenderContext,
  block: Block,
  reveal?: BlockReveal,
  cell?: Cell,
  decorated = true,
): void {
  const doc = ctx.doc;
  target.setAttribute(CONTENT_ATTR, '');
  if (inlineLength(inline) === 0) {
    target.classList.add('mbe-empty-content');
    // An empty block needs a <br> so it has height and can hold the caret.
    target.appendChild(fill(doc));
    return;
  }
  const decorations =
    block.type === 'code' ? (ctx.decorateCode?.(block) ?? []) : decorated && ctx.decorate ? ctx.decorate(block, inline, cell) : [];
  const only = inline.length === 1 ? inline[0]! : null;
  if (only && decorations.length === 0 && only.marks.length === 0 && !only.link && !only.token && !only.image) {
    // Plain text, the most common content: one text node.
    target.appendChild(doc.createTextNode(only.text));
  } else {
    renderInline(inline, target, ctx, decorations, reveal, cell);
  }
  // A trailing line break needs a <br> after it to show the empty last line.
  const last = inline[inline.length - 1];
  if (last && last.text.endsWith('\n')) target.appendChild(fill(doc));
}

/** A code block's copy button. The editor handles its clicks (see `Editor.copyCode`). */
function copyButton(ctx: RenderContext): HTMLElement {
  const button = ctx.doc.createElement('button');
  button.type = 'button';
  button.className = 'mbe-code-copy';
  button.tabIndex = -1;
  button.setAttribute('aria-label', ctx.labels.copyCode);
  button.title = ctx.labels.copyCode;
  const icon = ctx.icon?.('copyCode');
  if (icon) button.appendChild(icon);
  return button;
}

/**
 * Replaces the slot markers in a rendered HTML view with their content (see
 * htmlSection.ts). Slots whose marker is gone, inside an element the
 * sanitizer removed, follow the rest, so no Markdown the user wrote is lost.
 */
function fillSlots(root: HTMLElement, count: number, content: (index: number) => Node, doc: Document): void {
  if (count === 0) return;
  const texts: Text[] = [];
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue!.includes('\uE000')) texts.push(node as Text);
  const placed = new Set<number>();
  for (const text of texts) {
    const value = text.nodeValue!;
    const fragment = doc.createDocumentFragment();
    let last = 0;
    for (const m of value.matchAll(SLOT_MARKER)) {
      if (m.index > last) fragment.append(value.slice(last, m.index));
      const index = Number(m[1]);
      if (index < count && !placed.has(index)) {
        placed.add(index);
        fragment.append(content(index));
      }
      last = m.index + m[0].length;
    }
    if (last < value.length) fragment.append(value.slice(last));
    text.replaceWith(fragment);
  }
  // A view still loading: the slots fill when it settles. (Not an empty one, such as a sanitizer that removed everything: its slots follow here.)
  if (root.hasAttribute(PENDING_ATTR)) return;
  for (let i = 0; i < count; i++) if (!placed.has(i)) root.appendChild(content(i));
}

/**
 * The Markdown blocks between an HTML section's tags, rendered as the
 * editor's blocks but as content of the section, not blocks of the document:
 * nothing in them is editable or maps to a model position.
 */
function renderFlow(blocks: readonly Block[], ctx: RenderContext): HTMLElement {
  const flow = ctx.doc.createElement('div');
  flow.className = 'mbe-flow';
  appendBlocks(flow, blocks, ctx);
  makeInert(flow);
  return flow;
}

function appendBlocks(flow: HTMLElement, blocks: readonly Block[], ctx: RenderContext): void {
  const elements = new Map<string, HTMLElement>();
  // These blocks are content, not blocks of the document: block views, which are kept per document block, do not apply.
  const inner: RenderContext = ctx.blockView ? { ...ctx, blockView: undefined } : ctx;
  for (const block of blocks) {
    const el = renderBlock(block, inner);
    elements.set(block.id, el);
    flow.appendChild(el);
  }
  updateNeighborMarks({ blocks }, (id) => elements.get(id), new WeakMap(), new Set(), ctx.labels);
}

/** A footnote definition, `[^label]: text`, split for rendering. */
interface FootnoteDefinition {
  /** The label, with backslash escapes removed. */
  readonly label: string;
  /** `[^label]: `, as written, for the view. */
  readonly head: string;
  /** The text after the label: Markdown, possibly several blocks, with the continuation indent removed. */
  readonly body: string;
}

const FOOTNOTE_DEFINITION = /^(\[\^((?:[^\]\s\\]|\\.)+)\]:)[ \t]*(.*)$/;
/** References in the source of a footnote token: `[^1][^2]` is one token with two. */
const FOOTNOTE_REFERENCE = /\[\^((?:[^\]\s\\]|\\.)+)\]/g;
const unescapeLabel = (label: string): string => label.replace(/\\(.)/g, '$1');

function splitFootnote(source: string): FootnoteDefinition | null {
  const [first = '', ...rest] = source.split('\n');
  const m = FOOTNOTE_DEFINITION.exec(first);
  if (!m) return null;
  // Lines after the first sit four columns in, as on GitHub; what is indented further is content such as a code block.
  const body = [m[3]!, ...rest.map((line) => line.replace(/^(?: {1,4}|\t)/, ''))].join('\n');
  return { label: unescapeLabel(m[2]!), head: `${m[1]} `, body };
}

/**
 * A footnote definition rendered through the `footnote` view: the view gets
 * the label part and a slot marker in place of the text, and the text
 * renders as inline Markdown into the slot, with its links, formatting, tags
 * and tokens, as the Markdown of an HTML section does. Inert, like a section.
 */
function renderFootnote(definition: FootnoteDefinition, ctx: RenderContext): HTMLElement | null {
  const el = ctx.view?.('footnote', definition.head + slotMarker(0), 'block') ?? null;
  if (el) fillSlots(el, 1, () => renderInlineMarkdown(definition.body, ctx), ctx.doc);
  return el;
}

/** Markdown rendered as inline content: one paragraph's content in a span; anything else as blocks. */
function renderInlineMarkdown(source: string, ctx: RenderContext): HTMLElement {
  const flow = renderNodes(parseAst(source, ctx.markdown).children, ctx);
  const only = flow.childNodes.length === 1 ? flow.firstElementChild : null;
  if (flow.childNodes.length === 0 || (only && only.tagName === 'P')) {
    const span = ctx.doc.createElement('span');
    if (only) span.append(...Array.from(only.childNodes));
    makeInert(span);
    return span;
  }
  makeInert(flow);
  return flow;
}

/**
 * Marks the built-in view of raw Markdown blocks in `RenderContext.views`.
 * It is never called: the renderer draws those blocks itself (see
 * `renderMarkdown`), and an extension's own `markdown` view replaces it.
 */
export const MARKDOWN_VIEW: SyntaxView = () => false;

/**
 * A raw Markdown block, rendered: structure the flat model cannot hold, such
 * as a code block in a list item, drawn with the editor's own blocks. Runs of
 * nodes the model can hold render as blocks; a quote or list it cannot hold
 * becomes a container whose content renders the same way. As with an HTML
 * section, none of it is editable or maps to a model position: the caret or
 * a click shows the source.
 */
function renderMarkdown(source: string, ctx: RenderContext): HTMLElement {
  const root = ctx.doc.createElement('div');
  root.classList.add('mbe-view-markdown');
  root.appendChild(renderNodes(parseAst(source, ctx.markdown).children, ctx));
  makeInert(root);
  return root;
}

/**
 * Syntax tree nodes rendered as blocks. Runs of nodes the model can hold
 * render as blocks; a quote holding a quote, or a list the model cannot hold,
 * becomes a container whose content renders the same way. The tree is not
 * lowered with its source here, which would parse the source of each nested
 * quote again at every level.
 */
function renderNodes(nodes: readonly BlockNode[], ctx: RenderContext): HTMLElement {
  const options = ctx.markdown ?? DEFAULT_MARKDOWN;
  const flow = ctx.doc.createElement('div');
  flow.className = 'mbe-flow';
  let run: Block[] = [];
  for (const node of nodes) {
    const blocks = lowerIfFits(node, options, run[run.length - 1]);
    if (blocks) {
      run.push(...blocks);
      continue;
    }
    appendBlocks(flow, run, ctx);
    run = [];
    if (node.type === 'blockQuote') flow.appendChild(renderQuoteNode(node, ctx));
    else if (node.type === 'list') node.items.forEach((item, i) => flow.appendChild(renderItemNode(node, item, i, ctx)));
  }
  appendBlocks(flow, run, ctx);
  return flow;
}

/** A quote the model cannot hold, such as one with a code block in it: a blockquote holding its blocks. */
function renderQuoteNode(node: BlockQuoteNode, ctx: RenderContext): HTMLElement {
  const alert = ctx.markdown?.callouts === false ? null : calloutOf(node.children);
  const children = alert ? [...(alert.rest.length > 0 ? [{ type: 'paragraph' as const, children: [...alert.rest] }] : []), ...node.children.slice(1)] : node.children;
  const el = ctx.doc.createElement('blockquote');
  el.dir = 'auto';
  el.className = classes('mbe-block mbe-quote', ctx.classes.blockquote);
  if (alert) {
    el.dataset.callout = alert.type;
    el.appendChild(calloutIcon(alert.type, ctx));
  }
  el.appendChild(renderNodes(children, ctx));
  return el;
}

/** An item of a list the model cannot hold, such as one with two paragraphs: its marker, then its blocks. */
function renderItemNode(list: ListNode, node: ListItemNode, index: number, ctx: RenderContext): HTMLElement {
  const listType = node.task ? 'task' : list.ordered ? 'ordered' : 'bullet';
  const el = ctx.doc.createElement('div');
  el.dir = 'auto';
  el.className = classes('mbe-block mbe-list-item', ctx.classes[`${listType}List`]);
  el.dataset.listType = listType;
  el.dataset.indent = '0';
  if (index === 0) el.setAttribute(LIST_START_ATTR, '');
  const marker = ctx.doc.createElement('span');
  marker.className = 'mbe-marker';
  if (node.task) {
    const box = ctx.doc.createElement('input');
    box.className = 'mbe-checkbox';
    box.type = 'checkbox';
    box.checked = node.checked;
    marker.appendChild(box);
  } else if (list.ordered) {
    marker.textContent = `${list.start + index}.`;
  }
  const content = ctx.doc.createElement('div');
  content.className = 'mbe-content';
  content.appendChild(renderNodes(node.children, ctx));
  el.append(marker, content);
  return el;
}

/** Rendered blocks that are content of another block: no block ids, nothing editable, inputs inert. */
function makeInert(flow: HTMLElement): void {
  for (const el of Array.from(flow.querySelectorAll<HTMLElement>(`[${BLOCK_ATTR}], [${CONTENT_ATTR}], [contenteditable], [data-row]`))) {
    el.removeAttribute(BLOCK_ATTR);
    el.removeAttribute(CONTENT_ATTR);
    el.removeAttribute('contenteditable');
    el.removeAttribute('data-row');
    el.removeAttribute('data-col');
  }
  for (const input of Array.from(flow.querySelectorAll('input'))) {
    if (input.type === 'checkbox') input.disabled = true;
    else input.readOnly = true;
    input.tabIndex = -1;
  }
}

function fill(doc: Document): HTMLElement {
  const br = doc.createElement('br');
  br.setAttribute(FILL_ATTR, '');
  return br;
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** A tag or comment of inline raw HTML; what lies between is other HTML text. */
const HTML_PIECE = /<!--[\s\S]*?-->|<[^<>]*>/g;

/**
 * Inline content with each tag or comment of raw HTML as its own span.
 * Adjacent `html` spans are joined first, so several tags that
 * `normalizeInline` merged (`</rt></ruby><ruby>`) come apart, and a tag an
 * edit left in two spans is whole again. Everything else is unchanged.
 */
export function splitHtmlSpans(inline: Inline): Inline {
  if (!inline.some((s) => s.marks.includes('html'))) return inline;
  const out: Span[] = [];
  for (const span of normalizeInline(inline)) {
    if (!span.marks.includes('html')) {
      out.push(span);
      continue;
    }
    let last = 0;
    for (const m of span.text.matchAll(HTML_PIECE)) {
      if (m.index > last) out.push({ ...span, text: span.text.slice(last, m.index) });
      out.push({ ...span, text: m[0] });
      last = m.index + m[0].length;
    }
    if (last < span.text.length) out.push({ ...span, text: span.text.slice(last) });
  }
  return out;
}

/**
 * Runs of inline raw HTML that render as one piece: an opening tag through
 * its closing tag, with the text between (`<kbd>Ctrl</kbd>`), or a single tag
 * (`<br>`, an unmatched tag, a comment). A run may cross a link, as the tags
 * pass through other renderers verbatim and the browser pairs them. Offsets
 * are into the container's text.
 */
export function htmlRuns(inline: Inline): { from: number; to: number }[] {
  const spans: { span: Span; from: number; to: number }[] = [];
  let pos = 0;
  for (const span of splitHtmlSpans(inline)) {
    spans.push({ span, from: pos, to: pos + span.text.length });
    pos += span.text.length;
  }
  const isHtml = (span: Span) => span.marks.includes('html');
  const runs: { from: number; to: number }[] = [];
  for (let i = 0; i < spans.length; i++) {
    const { span, from, to } = spans[i]!;
    if (!isHtml(span)) continue;
    const open = /^<([A-Za-z][A-Za-z0-9-]*)\b[^>]*?(\/?)>$/.exec(span.text);
    let end = i;
    if (open && !open[2] && !VOID_TAGS.has(open[1]!.toLowerCase())) {
      const name = open[1]!.toLowerCase();
      let depth = 0;
      for (let j = i + 1; j < spans.length; j++) {
        const t = spans[j]!.span;
        if (!isHtml(t)) continue;
        const tag = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)\b[^>]*?(\/?)>$/.exec(t.text);
        if (!tag || tag[2]!.toLowerCase() !== name || tag[3]) continue;
        if (!tag[1]) depth++;
        else if (depth > 0) depth--;
        else {
          end = j;
          break;
        }
      }
    }
    runs.push({ from, to: end === i ? to : spans[end]!.to });
    i = end;
  }
  return runs;
}

function renderInline(
  inline: Inline,
  parent: HTMLElement,
  ctx: RenderContext,
  decorations: readonly Decoration[],
  reveal: BlockReveal | undefined,
  cell: Cell | undefined,
): void {
  const doc = ctx.doc;
  // Tokens with a view render whole, unless the selection reveals their source.
  const views = ctx.views;
  const viewed = views
    ? (span: Span, from: number) => !!span.token && views.has(span.token) && !reveal?.has(tokenKey(cell, from))
    : undefined;
  // Inline raw HTML renders through the `html` view, one run at a time, unless
  // revealed. Each tag is its own span, so a run starts and ends on a span.
  if (views?.has('html')) inline = splitHtmlSpans(inline);
  const runs = views?.has('html') && inline.some((s) => s.marks.includes('html'))
    ? htmlRuns(inline).filter((run) => !reveal?.has(tokenKey(cell, run.from)))
    : [];
  const inRun = (from: number) => runs.some((run) => from >= run.from && from < run.to);
  // A run's tags are atomic; the text between them is decorated and rendered as usual.
  const isHtml = (span: Span) => span.marks.includes('html');
  const atomic =
    viewed || runs.length > 0 ? (span: Span, from: number) => !!viewed?.(span, from) || (isHtml(span) && inRun(from)) : undefined;
  const pieces = splitByDecorations(inline, decorations, atomic);
  const render = (piece: (typeof pieces)[number]) => decorate(renderSpan(piece.span, ctx, piece.atomic && !isHtml(piece.span)), piece.decorations, doc);
  const offsets = new Map<(typeof pieces)[number], number>();
  let offset = 0;
  for (const piece of pieces) {
    offsets.set(piece, offset);
    offset += piece.span.text.length;
  }
  const linkElement = (span: Span): HTMLAnchorElement => {
    const a = doc.createElement('a');
    const href = ctx.resolveUrl(span.link!, 'link');
    if (href !== null) a.setAttribute('href', href);
    a.dataset.href = span.link!;
    if (span.linkTitle) a.title = span.linkTitle;
    a.className = classes('mbe-link', ctx.classes.link);
    return a;
  };
  const runAt = (i: number) => runs.find((r) => r.from === offsets.get(pieces[i]!));
  const runEnd = (i: number, run: { to: number }) => {
    let end = i;
    while (end < pieces.length && offsets.get(pieces[end]!)! < run.to) end++;
    return end;
  };
  // Whether every piece of the run shares the link of its first piece.
  const linkedRun = (i: number, run: { to: number }): boolean => {
    const span = pieces[i]!.span;
    if (!span.link) return false;
    for (let j = i + 1, end = runEnd(i, run); j < end; j++) if (!sameLink(pieces[j]!.span, span)) return false;
    return true;
  };
  // Renders the run that starts at piece `i` into `into`, which is the <a>
  // of the run's link when `linked`; returns the index of the next piece, or
  // null when there is no view for it.
  const renderRun = (i: number, run: { from: number; to: number }, into: Node, linked: boolean): number | null => {
    // The run's tags go to the view; the text between them, with its
    // formatting, tags, tokens and links, renders here and fills its slots.
    const html: string[] = [];
    const slots: Node[] = [];
    const end = runEnd(i, run);
    for (let j = i; j < end; ) {
      const piece = pieces[j]!;
      if (isHtml(piece.span)) {
        html.push(piece.span.text);
        j++;
        continue;
      }
      const slot = doc.createDocumentFragment();
      const stop = (k: number) => k >= end || isHtml(pieces[k]!.span);
      if (linked) for (; !stop(j); j++) slot.appendChild(render(pieces[j]!));
      else j = renderPieces(j, stop, slot);
      slots.push(slot);
      html.push(slotMarker(slots.length - 1));
    }
    const view = ctx.view?.('html', html.join(''), 'inline');
    if (!view) return null;
    fillSlots(view, slots.length, (n) => slots[n]!, doc);
    // One atom as long as the run's text, so DOM-to-model mapping still sees it.
    const text = inlineText(sliceInline(inline, run.from, run.to));
    into.appendChild(atom(view, classes('mbe-view', 'mbe-view-html', ctx.classes.token?.html), text));
    return end;
  };
  // Renders the pieces from `i` while `stop` is false into `into`; returns
  // the index of the next piece. Consecutive spans with the same link share
  // one <a>. A run inside a link renders into that <a>; a run that crosses a
  // link's edge renders outside links, with the linked text between its tags
  // in <a> elements of its own, as a browser pairs the tags other renderers
  // pass through.
  const renderPieces = (i: number, stop: (i: number) => boolean, into: Node): number => {
    while (i < pieces.length && !stop(i)) {
      const span = pieces[i]!.span;
      const run = runAt(i);
      if (run && !linkedRun(i, run)) {
        const next = renderRun(i, run, into, false);
        if (next !== null) {
          i = next;
          continue;
        }
      }
      if (!span.link) {
        into.appendChild(render(pieces[i]!));
        i++;
        continue;
      }
      const a = linkElement(span);
      const start = i;
      while (i < pieces.length && !stop(i) && sameLink(pieces[i]!.span, span)) {
        const inner = runAt(i);
        if (inner) {
          const whole = linkedRun(i, inner);
          // A crossing run renders outside this <a>, unless it has no view
          // (then it was tried above, and its pieces render as usual).
          if (!whole && i > start) break;
          const next = whole ? renderRun(i, inner, a, true) : null;
          if (next !== null) {
            i = next;
            continue;
          }
        }
        a.appendChild(render(pieces[i]!));
        i++;
      }
      into.appendChild(a);
    }
    return i;
  };
  renderPieces(0, () => false, parent);
}

/** Wraps a rendered span in one element per decoration. */
function decorate(node: Node, decorations: readonly Decoration[], doc: Document): Node {
  for (let i = decorations.length - 1; i >= 0; i--) {
    const d = decorations[i]!;
    const wrapper = doc.createElement('span');
    for (const [name, value] of Object.entries(d.attributes ?? {})) wrapper.setAttribute(name, value);
    wrapper.className = `mbe-deco ${d.class}`;
    wrapper.appendChild(node);
    node = wrapper;
  }
  return node;
}

/** A non-editable inline element that counts as `source.length` characters (one for an image). */
function atom<T extends HTMLElement>(el: T, className: string, source?: string): T {
  el.classList.add(...className.split(/\s+/).filter(Boolean));
  el.contentEditable = 'false';
  el.setAttribute(ATOM_ATTR, '');
  if (source !== undefined) el.dataset.source = source;
  return el;
}

function renderSpan(span: Span, ctx: RenderContext, viewed = false): Node {
  const doc = ctx.doc;
  const view = viewed ? ctx.view?.(span.token!, span.text, 'inline') : null;
  // One atom as long as the token's source. Clicking it shows the source (see Editor).
  if (view) return wrapMarks(span, atom(view, classes('mbe-view', `mbe-view-${span.token}`, ctx.classes.token?.[span.token!]), span.text), ctx);
  if (span.image) {
    const image = span.image;
    const src = ctx.resolveUrl(image.src, 'image');
    if (src === null) return unavailableImage(image, ctx);
    // A loaded image keeps its element when its block renders again, so it
    // does not collapse while a new element loads it.
    let img = ctx.loadedImage?.(src);
    if (!img) {
      const el = doc.createElement('img');
      // Off-screen images load when they come near the viewport.
      el.setAttribute('loading', 'lazy');
      el.setAttribute('decoding', 'async');
      if (ctx.referrerPolicy) el.setAttribute('referrerpolicy', ctx.referrerPolicy);
      el.src = src;
      el.addEventListener('error', () => {
        if (!el.parentNode) return;
        el.replaceWith(unavailableImage({ src, alt: el.alt, title: el.title || undefined }, ctx));
        ctx.onImageError?.();
      });
      img = el;
    }
    img.alt = image.alt;
    setAttribute(img, 'title', image.title);
    // The size is the most it shows at; CSS keeps it within the column and the aspect ratio.
    setAttribute(img, 'width', image.width ? String(image.width) : undefined);
    setAttribute(img, 'height', image.height ? String(image.height) : undefined);
    return atom(img, classes('mbe-image', ctx.classes.image));
  }
  let node: Node = doc.createTextNode(span.text);
  if (span.token) {
    // A token of a syntax extension, shown as its source.
    const wrapper = doc.createElement('span');
    wrapper.className = classes('mbe-token', `mbe-token-${span.token}`, ctx.classes.token?.[span.token]);
    wrapper.spellcheck = false;
    wrapper.appendChild(node);
    node = wrapper;
  }
  return wrapMarks(span, node, ctx);
}

function setAttribute(el: HTMLElement, name: string, value: string | undefined): void {
  if (value === undefined) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

/**
 * What shows in place of an image that did not load, or whose URL the policy
 * dropped: an icon and the alt text, as one atom like the image.
 */
function unavailableImage(image: ImageAtom, ctx: RenderContext): HTMLElement {
  const doc = ctx.doc;
  const el = doc.createElement('span');
  const text = image.alt || ctx.labels.imageUnavailable;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', text);
  if (image.title) el.title = image.title;
  const icon = ctx.icon?.('imageUnavailable');
  if (icon) el.appendChild(icon);
  const label = doc.createElement('span');
  label.className = 'mbe-image-alt';
  label.textContent = text;
  el.appendChild(label);
  return atom(el, classes('mbe-image', 'mbe-image-unavailable', ctx.classes.image));
}

function wrapMarks(span: Span, node: Node, ctx: RenderContext): Node {
  // Innermost mark first, so the outer order matches MARK_ORDER.
  for (let i = MARK_ORDER.length - 1; i >= 0; i--) {
    const mark = MARK_ORDER[i]!;
    if (!span.marks.includes(mark)) continue;
    const [tag, cls] = MARK_TAGS[mark];
    const wrapper = ctx.doc.createElement(tag);
    const className = mark === 'html' ? cls : ctx.classes[mark];
    if (className) wrapper.className = className;
    wrapper.appendChild(node);
    node = wrapper;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Rendering the document

/**
 * Keyed reconciliation. Blocks are immutable, so a block whose object is the
 * same as last render keeps its DOM element untouched.
 */
export class BlockRenderer {
  private rendered = new Map<string, { block: Block; el: HTMLElement; reveal?: BlockReveal }>();
  /** Last number written into each ordered item's marker, keyed by element. */
  private readonly numbers = new WeakMap<HTMLElement, number>();

  /** The URL policy for links and images. Set before a full render. */
  resolveUrl: ResolveUrl = defaultResolveUrl;
  /** `referrerpolicy` for images. */
  referrerPolicy?: ReferrerPolicy;
  /** Decorations for a text container. */
  decorate?: RenderContext['decorate'];
  /** Decorations for a code block's code. */
  decorateCode?: RenderContext['decorateCode'];
  /** Decorations for source mode's block. */
  decorateSource?: RenderContext['decorateSource'];
  /**
   * Called when views that returned a promise settle, with the blocks that
   * showed them. Those blocks must render again to show the finished view,
   * or their source if it failed.
   */
  onViewSettled?: (blockIds: readonly string[]) => void;
  /** Widget elements to place after a block. */
  widgetsAfter?: (blockId: string) => readonly HTMLElement[] | undefined;
  /** Views of extension syntaxes, by syntax name. */
  views?: ReadonlyMap<string, SyntaxView>;
  /**
   * Read-only: footnote definitions hide where they are written and the
   * referenced ones show again, in order of first reference, in a section
   * at the end of the document (see `footnoteSection`).
   */
  collectFootnotes = false;
  /** The last footnote section, kept while what it shows is the same. */
  private footnotes?: { key: string; el: HTMLElement };
  /** What a view gets besides its source: the editor. Set with `views`. */
  viewContext?: ExtensionContext;
  /** Block views of extensions, with the extension's name, in extension order. */
  blockViews: readonly { readonly name: string; readonly view: BlockView }[] = [];
  /**
   * Per block drawn by a block view, the element the view drew into (null
   * when every matching view declined), kept while the block object is the
   * same, and the function to call when the element is let go. A view placed
   * after its block has `after`: the editor's wrapper around that element,
   * placed after the block's element.
   */
  private readonly hosted = new Map<string, { block: Block; name: string; el: HTMLElement | null; after?: HTMLElement; dispose?: () => void }>();
  /** The document's Markdown options, for the Markdown inside an HTML section. */
  markdown?: MarkdownOptions;
  /** Theme classes for rendered elements. Set before a full render. */
  classes: ThemeClasses = NO_CLASSES;
  /** The icon of a UI control. */
  icon?: (name: IconName) => Node | null;
  /** Code blocks get a copy button. */
  codeCopy = false;
  /** Source mode: the code block renders as plain text. Changing it needs a forced render. */
  source = false;
  /** An image failed to load and now shows as unavailable. */
  onImageError?: () => void;
  /** Collapsible sections shown collapsed, by the ID of their title block. */
  collapsed: ReadonlySet<string> = new Set();
  /** Per block, the views that show their source. A block re-renders when its entry changes. */
  revealed: ReadonlyMap<string, BlockReveal> = new Map();
  /**
   * Rendered views by kind, syntax and source, least recently used first.
   * Cloned on reuse: typing re-renders a block and every formula in it.
   */
  private readonly viewCache = new Map<string, HTMLElement>();
  /** Views whose promise has not settled, by cache key, with the blocks showing them. */
  private readonly pendingViews = new Map<string, Set<string>>();
  /** Views whose promise rejected or resolved to false: their source shows. */
  private readonly failedViews = new Set<string>();
  /** Per cached or failed view, the blocks that showed it, to render again when `dropViews` forgets it. */
  private readonly viewBlocks = new Map<string, Set<string>>();
  /** The block being rendered, so a pending view knows which blocks to render again. */
  private renderingBlock = '';
  /** During a render, the loaded images of the block elements it replaces, by `src`. */
  private loadedImages = new Map<string, HTMLImageElement[]>();

  constructor(
    private readonly root: HTMLElement,
    private readonly labels: Labels,
  ) {}

  private context(): RenderContext {
    return {
      doc: this.root.ownerDocument,
      labels: this.labels,
      resolveUrl: this.resolveUrl,
      referrerPolicy: this.referrerPolicy,
      decorate: this.decorate,
      decorateCode: this.decorateCode,
      decorateSource: this.decorateSource,
      views: this.views,
      view: this.views && ((syntax, source, kind) => this.renderView(syntax, source, kind)),
      blockView: this.blockViews.length > 0 ? (block) => this.renderBlockView(block) : undefined,
      markdown: this.markdown,
      classes: this.classes,
      icon: this.icon,
      codeCopy: this.codeCopy,
      source: this.source,
      onImageError: this.onImageError,
      loadedImage: (src) => this.loadedImages.get(src)?.shift(),
    };
  }

  private renderView(syntax: string, source: string, kind: 'inline' | 'block'): HTMLElement | null {
    const view = this.views?.get(syntax);
    if (!view || !this.viewContext) return null;
    const key = `${kind}\0${syntax}\0${source}`;
    if (this.failedViews.has(key)) {
      this.noteViewBlock(key);
      return null;
    }
    let el = this.viewCache.get(key);
    if (el) {
      this.viewCache.delete(key);
    } else {
      el = this.root.ownerDocument.createElement(kind === 'inline' ? 'span' : 'div');
      let result: ReturnType<SyntaxView>;
      try {
        result = view(source, el, kind, this.viewContext);
      } catch {
        result = false;
      }
      if (result === false) {
        // Not remembered: the view runs again when the block renders again, and on `dropViews`.
        this.noteViewBlock(key);
        return null;
      }
      if (result && typeof result.then === 'function') {
        el.setAttribute(PENDING_ATTR, '');
        this.awaitView(key, result);
      }
      if (this.viewCache.size >= 500) {
        const oldest = this.viewCache.keys().next().value!;
        this.viewCache.delete(oldest);
        this.viewBlocks.delete(oldest);
      }
    }
    this.pendingViews.get(key)?.add(this.renderingBlock);
    this.noteViewBlock(key);
    this.viewCache.set(key, el);
    return el.cloneNode(true) as HTMLElement;
  }

  /** Whether a block view draws `block`: its blocks show their editable form only while the selection is in them. */
  isHosted(block: Block): boolean {
    return this.blockViews.some(({ view }) => view.match(block));
  }

  /**
   * The element a block view drew `block` into, to show in place of the
   * block: the one from the last render while the block object is the same,
   * else a fresh one from the first matching view that does not decline.
   * Null when none draws it, and for a view placed after the block, whose
   * element `afterView` gives.
   */
  private renderBlockView(block: Block): HTMLElement | null {
    const prev = this.hosted.get(block.id);
    if (prev && prev.block === block) return prev.after ? null : prev.el;
    if (prev) this.disposeHosted(block.id);
    const ctx = this.viewContext;
    if (!ctx) return null;
    let matched: string | null = null;
    for (const { name, view } of this.blockViews) {
      if (!view.match(block)) continue;
      matched = name;
      const el = this.root.ownerDocument.createElement('div');
      let result: ReturnType<BlockView['render']>;
      try {
        result = view.render(block, el, ctx);
      } catch {
        result = false;
      }
      if (result === false) continue;
      const dispose = typeof result === 'function' ? result : undefined;
      if (view.placement !== 'after') {
        this.hosted.set(block.id, { block, name, el, dispose });
        return el;
      }
      // The block stays as the editor draws it; the element follows it, like a widget.
      const after = this.root.ownerDocument.createElement('div');
      after.className = 'mbe-block-view mbe-block-after';
      after.contentEditable = 'false';
      after.appendChild(el);
      this.hosted.set(block.id, { block, name, el, after, dispose });
      return null;
    }
    // Every matching view declined: remembered, so the views do not run again until the block changes.
    if (matched !== null) this.hosted.set(block.id, { block, name: matched, el: null });
    return null;
  }

  /** The element of a block view placed after `block`, while the block shows the view (not its editable form). */
  private afterView(block: Block, reveal: BlockReveal | undefined): HTMLElement | undefined {
    if (reveal?.has(REVEAL_BLOCK) || this.source) return undefined;
    const entry = this.hosted.get(block.id);
    return entry?.block === block ? entry.after : undefined;
  }

  private disposeHosted(id: string): void {
    const entry = this.hosted.get(id);
    if (!entry) return;
    this.hosted.delete(id);
    try {
      entry.dispose?.();
    } catch {
      // A view's cleanup must not stop the render.
    }
  }

  /** Lets every block view's element go: on destroy. */
  destroy(): void {
    for (const id of [...this.hosted.keys()]) this.disposeHosted(id);
  }

  private noteViewBlock(key: string): void {
    let blocks = this.viewBlocks.get(key);
    if (!blocks) {
      // Declined views are not in the cache, so this map is bounded on its own.
      if (this.viewBlocks.size >= 1000) this.viewBlocks.delete(this.viewBlocks.keys().next().value!);
      this.viewBlocks.set(key, (blocks = new Set()));
    }
    blocks.add(this.renderingBlock);
  }

  /**
   * A view that renders later (a diagram, a lazily loaded renderer) shows what
   * it filled in at once, and its blocks render again when it settles.
   */
  private awaitView(key: string, result: PromiseLike<void | false>): void {
    const blocks = new Set<string>();
    this.pendingViews.set(key, blocks);
    const settle = (ok: boolean) => {
      // Dropped by `dropViews` while pending: a later render of the same source owns the key now.
      if (this.pendingViews.get(key) !== blocks) return;
      this.pendingViews.delete(key);
      this.viewCache.get(key)?.removeAttribute(PENDING_ATTR);
      if (!ok) {
        this.failedViews.add(key);
        this.viewCache.delete(key);
      }
      if (blocks.size > 0) this.onViewSettled?.([...blocks]);
    };
    result.then(
      (value) => settle(value !== false),
      () => settle(false),
    );
  }

  /**
   * Forgets rendered and failed views, of one syntax or all, so the next
   * render runs the view again: for when what it shows depends on something
   * besides its source that changed, such as the editor's font. Returns the
   * rendered blocks that showed them, for the caller to render again.
   */
  dropViews(syntax?: string): string[] {
    const matches = (key: string) => syntax === undefined || key.split('\0', 3)[1] === syntax;
    for (const key of [...this.viewCache.keys()]) if (matches(key)) this.viewCache.delete(key);
    for (const key of [...this.failedViews]) if (matches(key)) this.failedViews.delete(key);
    for (const key of [...this.pendingViews.keys()]) if (matches(key)) this.pendingViews.delete(key);
    const ids = new Set<string>();
    for (const [key, blocks] of [...this.viewBlocks]) {
      if (!matches(key)) continue;
      this.viewBlocks.delete(key);
      for (const id of blocks) if (this.rendered.has(id)) ids.add(id);
    }
    // Block views, by their extension's name.
    for (const [id, entry] of [...this.hosted]) {
      if (syntax !== undefined && entry.name !== syntax) continue;
      this.disposeHosted(id);
      if (this.rendered.has(id)) ids.add(id);
    }
    return [...ids];
  }

  /**
   * `force` re-renders every block. `lazy` (with a full render) lets blocks
   * skip layout while off screen; use it only when loading a document.
   */
  render(doc: Doc, force = false, lazy = false): void {
    const ctx = this.context();
    const kept = new Set<HTMLElement>();
    for (const block of doc.blocks) {
      const prev = this.rendered.get(block.id);
      if (!force && prev && prev.block === block && prev.el.parentNode === this.root && sameReveal(prev.reveal, this.revealed.get(block.id))) kept.add(prev.el);
    }
    // Images that loaded in the elements being replaced move to the new
    // elements, even in another block, instead of loading again.
    if (!force) {
      for (const { el } of this.rendered.values()) {
        if (kept.has(el)) continue;
        for (const img of Array.from(el.querySelectorAll<HTMLImageElement>('img.mbe-image'))) {
          const src = img.getAttribute('src');
          if (src === null || !img.complete || img.naturalWidth === 0) continue;
          const list = this.loadedImages.get(src);
          if (list) list.push(img);
          else this.loadedImages.set(src, [img]);
        }
      }
    }
    const next = new Map<string, { block: Block; el: HTMLElement; reveal?: BlockReveal }>();
    for (const block of doc.blocks) {
      this.renderingBlock = block.id;
      const prev = this.rendered.get(block.id);
      const reveal = this.revealed.get(block.id);
      let el = prev && kept.has(prev.el) ? prev.el : null;
      // Source mode's block changes on every keystroke: its element is brought up to date, line by line.
      if (!el && ctx.source && block.type === 'code' && prev?.block.type === 'code' && prev.el.parentNode === this.root && this.patchSource(prev.el, block, ctx)) {
        el = prev.el;
      }
      if (!el) {
        el = renderBlock(block, ctx, reveal);
        if (prev && block.type === 'raw') keepDetailsOpen(prev.el, el);
      }
      next.set(block.id, { block, el, reveal });
    }
    this.loadedImages.clear();
    // A block view's element goes when its block is gone, or changed while the block showed its editable form.
    for (const [id, entry] of [...this.hosted]) if (next.get(id)?.block !== entry.block) this.disposeHosted(id);

    const collecting = this.collectFootnotes && this.views?.has('footnote') === true;
    for (const { block, el } of next.values()) {
      if (block.type === 'raw' && block.syntax === 'footnote') el.classList.toggle('mbe-footnote-collected', collecting);
    }
    const footnotes = collecting ? this.footnoteSection(doc, next, ctx, force) : null;
    if (!collecting) this.footnotes = undefined;

    // Block elements in order, each followed by the block view placed after it, then its widgets; then the footnotes.
    const nodes: HTMLElement[] = [];
    for (const [id, { block, el, reveal }] of next) {
      nodes.push(el);
      const after = this.afterView(block, reveal);
      if (after) nodes.push(after);
      const widgets = this.widgetsAfter?.(id);
      if (widgets) nodes.push(...widgets);
    }
    if (footnotes) nodes.push(footnotes);

    if (force || this.rendered.size === 0) {
      // Full render: build off-document and insert once.
      // Only a loaded document's blocks may skip layout off screen. Chrome
      // treats a new content-visibility block as skipped until the next frame,
      // and arrow keys pressed before then put the caret in the wrong place,
      // so blocks rendered while editing never get it.
      const fragment = this.root.ownerDocument.createDocumentFragment();
      for (const el of nodes) {
        if (lazy && el.hasAttribute(BLOCK_ATTR)) el.classList.add('mbe-lazy');
        fragment.appendChild(el);
      }
      this.root.replaceChildren(fragment);
    } else {
      let ref: ChildNode | null = this.root.firstChild;
      let moved = false;
      for (const el of nodes) {
        if (el === ref) {
          ref = ref.nextSibling;
        } else {
          this.root.insertBefore(el, ref);
          moved = true;
        }
      }
      // Remove stale blocks and anything the browser inserted on its own.
      if (moved || ref !== null || this.root.childNodes.length !== nodes.length) {
        const keep = new Set<Node>(nodes);
        for (const child of Array.from(this.root.childNodes)) {
          if (!keep.has(child)) child.remove();
        }
      }
    }
    this.rendered = next;
    updateNeighborMarks(doc, (id) => next.get(id)?.el, this.numbers, this.collapsed, this.labels);
  }

  /**
   * The footnotes section, as GitHub renders one: every definition that is
   * referenced, in order of first reference, each rendered as its block is
   * (see `renderFootnote`) with a backlink per reference. Definitions nothing
   * references are left out. Null when there is nothing to show. The element
   * is kept while the definitions and references are the same.
   */
  private footnoteSection(doc: Doc, next: ReadonlyMap<string, { block: Block; el: HTMLElement }>, ctx: RenderContext, force: boolean): HTMLElement | null {
    const definitions = new Map<string, FootnoteDefinition>();
    for (const block of doc.blocks) {
      if (block.type !== 'raw' || block.syntax !== 'footnote') continue;
      const definition = splitFootnote(inlineText(block.content));
      if (definition && !definitions.has(definition.label)) definitions.set(definition.label, definition);
    }
    if (definitions.size === 0) return null;
    // From the rendered references, so those inside HTML sections and raw Markdown count too.
    const order: string[] = [];
    const counts = new Map<string, number>();
    for (const block of doc.blocks) {
      const el = next.get(block.id)?.el;
      if (!el) continue;
      for (const ref of Array.from(el.querySelectorAll<HTMLElement>('.mbe-view-footnote'))) {
        for (const m of (ref.dataset.source ?? '').matchAll(FOOTNOTE_REFERENCE)) {
          const label = unescapeLabel(m[1]!);
          if (!definitions.has(label)) continue;
          const count = (counts.get(label) ?? 0) + 1;
          counts.set(label, count);
          if (count === 1) order.push(label);
        }
      }
    }
    if (order.length === 0) return null;
    const key = JSON.stringify(order.map((label) => [label, definitions.get(label)!.body, counts.get(label)]));
    if (!force && this.footnotes?.key === key) return this.footnotes.el;
    const section = ctx.doc.createElement('section');
    section.className = 'mbe-footnotes';
    section.contentEditable = 'false';
    section.setAttribute('aria-label', this.labels.footnotes);
    for (const label of order) {
      const item = renderFootnote(definitions.get(label)!, ctx);
      if (!item) continue;
      // The backlinks end the note's text. When it has several blocks they go
      // in its last paragraph, or in a new one after a last block that is not
      // a paragraph, as GitHub places them.
      let target: Element = item.lastElementChild ?? item;
      const flow = target.querySelector(':scope > .mbe-flow');
      if (flow) {
        const last = flow.lastElementChild;
        if (last?.tagName === 'P') {
          target = last;
        } else {
          target = ctx.doc.createElement('p');
          target.className = 'mbe-block mbe-paragraph';
          flow.appendChild(target);
        }
      }
      for (let i = 1; i <= counts.get(label)!; i++) {
        const back = ctx.doc.createElement('button');
        back.type = 'button';
        back.className = 'mbe-footnote-backref';
        back.dataset.label = label;
        back.dataset.ref = String(i);
        back.setAttribute('aria-label', `${this.labels.backToReference} ${label}${i > 1 ? ` ${i}` : ''}`);
        // A small arrow, quiet as Notion's and Linear's controls; text where the app draws no icons.
        const icon = ctx.icon?.('backToReference');
        if (icon) back.appendChild(icon);
        else back.textContent = '\u2191';
        if (i > 1) {
          const sup = ctx.doc.createElement('sup');
          sup.textContent = String(i);
          back.appendChild(sup);
        }
        target.appendChild(back);
      }
      section.appendChild(item);
    }
    this.footnotes = { key, el: section };
    return section;
  }

  /** Marks blocks again after `collapsed` changed, without rendering any. */
  updateSections(doc: Doc): void {
    updateNeighborMarks(doc, (id) => this.rendered.get(id)?.el, this.numbers, this.collapsed, this.labels);
  }

  elementFor(id: string): HTMLElement | undefined {
    return this.rendered.get(id)?.el;
  }

  /**
   * Keeps a block's element for a new version of the block, when the browser
   * has already edited the element to show it (during IME composition).
   * Only the empty state is updated, so a placeholder does not cover the text.
   */
  adopt(block: Block): void {
    const prev = this.rendered.get(block.id);
    if (!prev) return;
    this.rendered.set(block.id, { ...prev, block });
    if ('content' in block) prev.el.classList.toggle('mbe-empty', inlineLength(block.content) === 0);
  }

  /** Forget a block's element so the next render rebuilds it, e.g. after the browser edited it during IME composition. */
  invalidate(id: string): void {
    this.rendered.delete(id);
  }

  /** Brings source mode's rendered block up to date with the block's text and decorations, in place. False when it has no content element. */
  private patchSource(el: HTMLElement, block: CodeBlock, ctx = this.context()): boolean {
    const content = contentElement(el);
    if (!content) return false;
    fillSource(content, block, ctx);
    el.classList.toggle('mbe-empty', inlineLength(block.content) === 0);
    return true;
  }

  /** Renders source mode's block again with the decorations as they are now, without touching the lines whose text and decorations are the same. */
  refreshSource(block: CodeBlock): void {
    const prev = this.rendered.get(block.id);
    if (prev && prev.el.parentNode === this.root) this.patchSource(prev.el, block);
  }
}

/**
 * Indents a block inside collapsible sections by their number (`depth`), and
 * hides it inside a collapsed one. On a section title, `collapsed` says
 * whether its own section is collapsed.
 */
function markSection(el: HTMLElement, depth: number, hidden: boolean, collapsed: boolean | null, labels: Labels): void {
  const value = depth > 0 ? String(depth) : '';
  if (el.style.getPropertyValue('--mbe-section-depth') !== value) {
    if (value) el.style.setProperty('--mbe-section-depth', value);
    else el.style.removeProperty('--mbe-section-depth');
  }
  setFlag(el, SECTION_INSIDE_ATTR, depth > 0);
  setFlag(el, SECTION_HIDDEN_ATTR, hidden);
  if (collapsed === null) return;
  setFlag(el, SECTION_COLLAPSED_ATTR, collapsed);
  const toggle = el.querySelector('.mbe-details-toggle');
  const expanded = String(!collapsed);
  if (toggle && toggle.getAttribute('aria-expanded') !== expanded) {
    toggle.setAttribute('aria-expanded', expanded);
    toggle.setAttribute('aria-label', collapsed ? labels.expandSection : labels.collapseSection);
  }
}

/**
 * Numbers ordered list items and marks where lists start and quotes continue.
 * Runs after every render, because all of these depend on the blocks above.
 * Attributes rather than sibling selectors: in Chrome, a `+` rule that can
 * match every block makes each edit restyle all the blocks after it.
 */
function updateNeighborMarks(
  doc: Doc,
  elementFor: (id: string) => HTMLElement | undefined,
  written: WeakMap<HTMLElement, number>,
  collapsed: ReadonlySet<string>,
  labels: Labels,
): void {
  const counters: (number | undefined)[] = [];
  /** Whether the current list's last top-level item is numbered. */
  let topOrdered: boolean | undefined;
  /** The open collapsible sections around the block: whether each is collapsed. */
  const sections: boolean[] = [];
  doc.blocks.forEach((block, i) => {
    const before = doc.blocks[i - 1];
    const el = elementFor(block.id);
    if (block.type === 'detailsEnd') sections.pop();
    if (el) markSection(el, sections.length, sections.includes(true), block.type === 'details' ? collapsed.has(block.id) : null, labels);
    if (block.type === 'details') sections.push(collapsed.has(block.id));
    // Adjacent quote blocks and quoted list items with the same callout are
    // parts of one quote; the stylesheet joins them.
    if (quoteKind(block) !== null) {
      setFlag(el, QUOTE_JOINED_ATTR, sameQuote(before, block));
      setFlag(el, QUOTE_CONTINUED_ATTR, sameQuote(block, doc.blocks[i + 1]));
    }
    // A list ends where a quote starts or ends.
    if (block.type !== 'listItem' || before?.type !== 'listItem' || quoteKind(before) !== quoteKind(block)) {
      counters.length = 0;
      topOrdered = undefined;
    }
    if (block.type !== 'listItem') return;
    // A list starts after a non-list block, or where a top-level item switches
    // between numbered and not from the top-level item above it (nested items
    // between them do not count). The stylesheet puts the block gap above it.
    const ordered = block.listType === 'ordered';
    setFlag(el, LIST_START_ATTR, counters.length === 0 || (block.indent === 0 && topOrdered !== undefined && ordered !== topOrdered));
    if (block.indent === 0) topOrdered = ordered;
    counters.length = block.indent + 1;
    if (!ordered) {
      counters[block.indent] = undefined;
      return;
    }
    const n = counters[block.indent] === undefined ? (block.start ?? 1) : counters[block.indent]! + 1;
    counters[block.indent] = n;
    if (!el || written.get(el) === n) return;
    const marker = el.querySelector('.mbe-marker');
    if (marker) marker.textContent = `${n}.`;
    written.set(el, n);
  });
}

/** A rendered HTML section keeps the `<details>` the reader opened or closed when it renders again. */
function keepDetailsOpen(from: HTMLElement, to: HTMLElement): void {
  const before = from.querySelectorAll('details');
  if (before.length === 0) return;
  const after = to.querySelectorAll('details');
  if (after.length !== before.length) return;
  before.forEach((details, i) => {
    after[i]!.open = details.open;
  });
}

function setFlag(el: HTMLElement | undefined, attr: string, on: boolean): void {
  if (el && el.hasAttribute(attr) !== on) el.toggleAttribute(attr, on);
}

// ---------------------------------------------------------------------------
// DOM <-> model positions

function blockElementOf(root: HTMLElement, node: Node): HTMLElement | null {
  let n: Node | null = node;
  while (n && n.parentNode !== root) n = n.parentNode;
  return n instanceof HTMLElement && n.hasAttribute(BLOCK_ATTR) ? n : null;
}

export function contentElement(blockEl: HTMLElement, cell?: Cell): HTMLElement | null {
  if (cell) return blockEl.querySelector<HTMLElement>(`[data-row="${cell.row}"][data-col="${cell.col}"]`);
  if (blockEl.hasAttribute(CONTENT_ATTR)) return blockEl;
  return blockEl.querySelector<HTMLElement>(`[${CONTENT_ATTR}]`);
}

/**
 * Text nodes and atoms inside a content element, in order. An image counts
 * as one character; a rendered token as many as its source.
 */
function leaves(contentEl: HTMLElement): (Text | HTMLElement)[] {
  const out: (Text | HTMLElement)[] = [];
  const walk = (node: Node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) out.push(child as Text);
      else if (child instanceof HTMLElement) {
        if (child.hasAttribute(ATOM_ATTR)) out.push(child);
        else if (!child.hasAttribute(FILL_ATTR)) walk(child);
      }
    }
  };
  walk(contentEl);
  return out;
}

/** The text a leaf stands for: a text node's data, a rendered token's source, or ATOM_CHAR for an image. */
function leafText(leaf: Text | HTMLElement): string {
  return leaf.nodeType === 3 ? (leaf as Text).data : ((leaf as HTMLElement).dataset.source ?? ATOM_CHAR);
}

function leafLength(leaf: Text | HTMLElement): number {
  return leafText(leaf).length;
}

/** Index of a node among its parent's child nodes. */
export function childIndex(node: Node): number {
  return Array.prototype.indexOf.call(node.parentNode!.childNodes, node);
}

/** Plain text of a content element as the browser currently has it, with atoms as one character. */
export function domText(contentEl: HTMLElement): string {
  if (contentEl.classList.contains(SOURCE_TEXT)) return sourceDomText(contentEl);
  return leaves(contentEl)
    .map(leafText)
    .join('');
}

/** The text before `child` of source mode's content element (or before its end): each line before it with its line ending. */
function lengthBefore(contentEl: HTMLElement, child: Node | null): number {
  let acc = 0;
  for (const [line, length] of sourceLineLengths(contentEl)) {
    if (line === child) return acc;
    acc += length + 1;
  }
  // Before the end, the last line has no line ending after it.
  return child === null && acc > 0 ? acc - 1 : acc;
}

function offsetIn(contentEl: HTMLElement, node: Node, offset: number): number {
  if (!contentEl.contains(node)) {
    // A point on a marker or other chrome: before or after the content.
    const before = node.compareDocumentPosition(contentEl) & Node.DOCUMENT_POSITION_FOLLOWING;
    return before ? 0 : leaves(contentEl).reduce((n, l) => n + leafLength(l), 0);
  }
  // Source mode's text is one span per line: the lines before the point are counted by length, not walked.
  if (contentEl.classList.contains(SOURCE_TEXT)) {
    if (node === contentEl) return lengthBefore(contentEl, contentEl.childNodes[offset] ?? null);
    const line = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(`.${SOURCE_LINE}`);
    if (line?.parentNode === contentEl) return lengthBefore(contentEl, line) + offsetIn(line, node, offset);
  }
  const doc = contentEl.ownerDocument;
  const point = doc.createRange();
  point.setStart(node, offset);
  let acc = 0;
  for (const leaf of leaves(contentEl)) {
    const len = leafLength(leaf);
    if (leaf === node) return acc + Math.min(offset, len);
    if (leaf.contains(node)) return acc; // inside an atom
    // Count the leaf if it ends at or before the point.
    const end = doc.createRange();
    if (leaf.nodeType === 3) end.setStart(leaf, len);
    else end.setStartAfter(leaf);
    if (end.compareBoundaryPoints(Range.START_TO_START, point) <= 0) acc += len;
    else return acc;
  }
  return acc;
}

export function domToPosition(root: HTMLElement, node: Node, offset: number): Position | null {
  let target = node;
  let off = offset;
  if (node === root) {
    const child = root.childNodes[Math.min(offset, root.childNodes.length - 1)];
    if (!child) return null;
    const atEnd = offset >= root.childNodes.length;
    target = child;
    off = atEnd ? child.childNodes.length : 0;
    if (atEnd) {
      const el = child as HTMLElement;
      const content = el.hasAttribute?.(BLOCK_ATTR) ? contentElement(el) : null;
      if (content) return { blockId: el.getAttribute(BLOCK_ATTR)!, offset: domText(content).length };
    }
  }
  const blockEl = blockElementOf(root, target);
  if (!blockEl) return null;
  const blockId = blockEl.getAttribute(BLOCK_ATTR)!;
  if (blockEl.classList.contains('mbe-divider')) return { blockId, offset: 0 };
  if (blockEl.classList.contains('mbe-table')) {
    const cellEl = (target instanceof Element ? target : target.parentElement)?.closest<HTMLElement>('[data-row]');
    if (!cellEl || !blockEl.contains(cellEl)) return { blockId, offset: 0, cell: { row: 0, col: 0 } };
    const cell = { row: Number(cellEl.dataset.row), col: Number(cellEl.dataset.col) };
    return { blockId, offset: offsetIn(cellEl, target, off), cell };
  }
  const content = contentElement(blockEl);
  if (!content) return { blockId, offset: 0 };
  return { blockId, offset: offsetIn(content, target, off) };
}

/** The atom (an image or a rendered token) that starts at `pos`, or null. */
export function atomAt(blockEl: HTMLElement, pos: Position): HTMLElement | null {
  const content = contentElement(blockEl, pos.cell);
  if (!content || content.classList.contains(SOURCE_TEXT)) return null;
  let acc = 0;
  for (const leaf of leaves(content)) {
    if (acc === pos.offset && leaf.nodeType !== 3) return leaf as HTMLElement;
    acc += leafLength(leaf);
    if (acc > pos.offset) return null;
  }
  return null;
}

export function positionToDom(blockEl: HTMLElement, pos: Position): { node: Node; offset: number } {
  const content = contentElement(blockEl, pos.cell);
  if (!content) {
    // A divider or rendered block: select around it.
    return { node: blockEl.parentNode!, offset: childIndex(blockEl) };
  }
  if (content.classList.contains(SOURCE_TEXT)) {
    // One element per line: find the line by length, then the point in it. An offset at a line's end stays on that line.
    let acc = 0;
    let last: [HTMLElement, number] | null = null;
    for (const entry of sourceLineLengths(content)) {
      const [line, length] = entry;
      if (pos.offset <= acc + length) return positionIn(line, pos.offset - acc);
      acc += length + 1;
      last = entry;
    }
    return last ? positionIn(last[0], last[1]) : { node: content, offset: 0 };
  }
  return positionIn(content, pos.offset);
}

/** The DOM point for a text offset within a content element (or one line of source mode's text). */
function positionIn(content: HTMLElement, offset: number): { node: Node; offset: number } {
  let acc = 0;
  const all = leaves(content);
  for (const leaf of all) {
    const len = leafLength(leaf);
    if (leaf.nodeType === 3) {
      const text = leaf as Text;
      if (acc + len >= offset) {
        const local = offset - acc;
        // After a trailing line break, put the caret before the filler <br> so it shows on the empty last line.
        if (local === len && leaf === all[all.length - 1] && text.data.endsWith('\n')) {
          const br = content.querySelector(`[${FILL_ATTR}]`);
          if (br) return { node: br.parentNode!, offset: childIndex(br) };
        }
        return { node: text, offset: local };
      }
    } else if (offset < acc + len) {
      // Before an atom, or after a rendered token when the offset falls inside its source.
      return { node: leaf.parentNode!, offset: childIndex(leaf) + (acc === offset ? 0 : 1) };
    }
    acc += len;
  }
  const last = all[all.length - 1];
  if (!last) return { node: content, offset: 0 };
  if (last.nodeType === 3) return { node: last, offset: (last as Text).length };
  return { node: last.parentNode!, offset: childIndex(last) + 1 };
}
