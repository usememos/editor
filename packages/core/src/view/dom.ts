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
  type Doc,
  type Inline,
  type Mark,
  type Position,
  type Span,
  MARK_ORDER,
  ATOM_CHAR,
  inlineLength,
  inlineText,
} from '../model';
import type { SyntaxView } from '../extension';
import type { Labels } from '../labels';
import type { ThemeClasses } from '../theme';
import { type Decoration, decorationContext, splitByDecorations } from '../decorations';

export const BLOCK_ATTR = 'data-block-id';
const CONTENT_ATTR = 'data-content';
const FILL_ATTR = 'data-mbe-fill';
const ATOM_ATTR = 'data-atom';
const LIST_START_ATTR = 'data-list-start';
const QUOTE_JOINED_ATTR = 'data-quote-joined';

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

/** The theme's classes for a block's element. */
function blockClasses(block: Block, theme: ThemeClasses): string | undefined {
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
  }
}

/** Only these URL schemes become clickable `href`s. Others are kept in the model but not linked. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!scheme) return trimmed; // relative URL or fragment
  return ['http', 'https', 'mailto', 'tel'].includes(scheme[1]!.toLowerCase()) ? trimmed : null;
}

/** What rendering needs besides the block. */
export interface RenderContext {
  readonly doc: Document;
  readonly labels: Labels;
  readonly resolveImageSrc?: (src: string) => string;
  /** Decorations for a text container. */
  readonly decorate?: (block: Block, content: Inline, cell?: Cell) => readonly Decoration[];
  /** Syntaxes that have a view. */
  readonly views?: ReadonlyMap<string, SyntaxView>;
  /** A token or raw block of an extension syntax, rendered; null shows its source. */
  readonly view?: (syntax: string, source: string, kind: 'inline' | 'block') => HTMLElement | null;
  /** Theme classes for rendered elements. */
  readonly classes: ThemeClasses;
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

function renderBlock(block: Block, ctx: RenderContext, reveal?: BlockReveal): HTMLElement {
  const { doc, labels } = ctx;
  const el = (tag: string, className?: string) => {
    const e = doc.createElement(tag);
    if (className) e.className = className;
    return e;
  };
  let root: HTMLElement;
  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'quote':
      root = el(block.type === 'paragraph' ? 'p' : block.type === 'quote' ? 'blockquote' : `h${block.level}`);
      fillContent(root, block.content, ctx, block, reveal);
      break;
    case 'listItem': {
      root = el('div');
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
      const view = reveal?.has(REVEAL_BLOCK) ? null : ctx.view?.(block.syntax, inlineText(block.content), 'block');
      if (view) {
        root = view;
        root.classList.add('mbe-view-block');
        root.contentEditable = 'false';
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
  root.setAttribute(BLOCK_ATTR, block.id);
  // One className write instead of several classList calls: this runs for every block on load.
  let className = `${root.className ? root.className + ' ' : ''}mbe-block mbe-${block.type === 'listItem' ? 'list-item' : block.type}`;
  if (block.type === 'listItem' && block.checked) className += ' mbe-checked';
  if ('content' in block && inlineLength(block.content) === 0) className += ' mbe-empty';
  const themed = blockClasses(block, ctx.classes);
  if (themed) className += ' ' + themed;
  root.className = className;
  return root;
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
  const decorations = decorated && ctx.decorate ? ctx.decorate(block, inline, cell) : [];
  renderInline(inline, target, ctx, decorations, reveal, cell);
  // A trailing line break needs a <br> after it to show the empty last line.
  const last = inline[inline.length - 1];
  if (last && last.text.endsWith('\n')) target.appendChild(fill(doc));
}

function fill(doc: Document): HTMLElement {
  const br = doc.createElement('br');
  br.setAttribute(FILL_ATTR, '');
  return br;
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
  const pieces = splitByDecorations(inline, decorations, viewed);
  const render = (piece: (typeof pieces)[number]) =>
    decorate(renderSpan(piece.span, ctx, piece.atomic), piece.decorations, doc);
  // Consecutive spans with the same link share one <a>.
  let i = 0;
  while (i < pieces.length) {
    const span = pieces[i]!.span;
    if (span.link) {
      const a = doc.createElement('a');
      const href = safeHref(span.link);
      if (href !== null) a.setAttribute('href', href);
      a.dataset.href = span.link;
      a.className = classes('mbe-link', ctx.classes.link);
      while (i < pieces.length && pieces[i]!.span.link === span.link) {
        a.appendChild(render(pieces[i]!));
        i++;
      }
      parent.appendChild(a);
    } else {
      parent.appendChild(render(pieces[i]!));
      i++;
    }
  }
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
    const img = doc.createElement('img');
    const src = safeHref(ctx.resolveImageSrc ? ctx.resolveImageSrc(span.image.src) : span.image.src);
    if (src !== null) img.src = src;
    img.alt = span.image.alt;
    if (span.image.title) img.title = span.image.title;
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

  /** Maps an image `src` to the URL to display. Set before a full render. */
  resolveImageSrc?: (src: string) => string;
  /** Decorations for a text container. */
  decorate?: RenderContext['decorate'];
  /** Widget elements to place after a block. */
  widgetsAfter?: (blockId: string) => readonly HTMLElement[] | undefined;
  /** Views of extension syntaxes, by syntax name. */
  views?: ReadonlyMap<string, SyntaxView>;
  /** Theme classes for rendered elements. Set before a full render. */
  classes: ThemeClasses = NO_CLASSES;
  /** Per block, the views that show their source. A block re-renders when its entry changes. */
  revealed: ReadonlyMap<string, BlockReveal> = new Map();
  /**
   * Rendered views by kind, syntax and source, least recently used first.
   * Cloned on reuse: typing re-renders a block and every formula in it.
   */
  private readonly viewCache = new Map<string, HTMLElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly labels: Labels,
  ) {}

  private context(): RenderContext {
    return {
      doc: this.root.ownerDocument,
      labels: this.labels,
      resolveImageSrc: this.resolveImageSrc,
      decorate: this.decorate,
      views: this.views,
      view: this.views && ((syntax, source, kind) => this.renderView(syntax, source, kind)),
      classes: this.classes,
    };
  }

  private renderView(syntax: string, source: string, kind: 'inline' | 'block'): HTMLElement | null {
    const view = this.views?.get(syntax);
    if (!view) return null;
    const key = `${kind}\0${syntax}\0${source}`;
    let el = this.viewCache.get(key);
    if (el) {
      this.viewCache.delete(key);
    } else {
      el = this.root.ownerDocument.createElement(kind === 'inline' ? 'span' : 'div');
      try {
        if (view(source, el, kind) === false) return null;
      } catch {
        return null;
      }
      if (this.viewCache.size >= 500) this.viewCache.delete(this.viewCache.keys().next().value!);
    }
    this.viewCache.set(key, el);
    return el.cloneNode(true) as HTMLElement;
  }

  /**
   * `force` re-renders every block. `lazy` (with a full render) lets blocks
   * skip layout while off screen; use it only when loading a document.
   */
  render(doc: Doc, force = false, lazy = false): void {
    const ctx = this.context();
    const next = new Map<string, { block: Block; el: HTMLElement; reveal?: BlockReveal }>();
    for (const block of doc.blocks) {
      const prev = this.rendered.get(block.id);
      const reveal = this.revealed.get(block.id);
      const reuse = !force && prev && prev.block === block && prev.el.parentNode === this.root && sameReveal(prev.reveal, reveal);
      next.set(block.id, { block, el: reuse ? prev.el : renderBlock(block, ctx, reveal), reveal });
    }

    // Block elements in order, each followed by its widgets.
    const nodes: HTMLElement[] = [];
    for (const [id, { el }] of next) {
      nodes.push(el);
      const widgets = this.widgetsAfter?.(id);
      if (widgets) nodes.push(...widgets);
    }

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
    updateNeighborMarks(doc, (id) => next.get(id)?.el, this.numbers);
  }

  elementFor(id: string): HTMLElement | undefined {
    return this.rendered.get(id)?.el;
  }

  /** Forget a block's element so the next render rebuilds it, e.g. after the browser edited it during IME composition. */
  invalidate(id: string): void {
    this.rendered.delete(id);
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
): void {
  const counters: (number | undefined)[] = [];
  doc.blocks.forEach((block, i) => {
    const before = doc.blocks[i - 1];
    const el = elementFor(block.id);
    // Adjacent quote blocks are paragraphs of one quote; the stylesheet joins them.
    if (block.type === 'quote') setFlag(el, QUOTE_JOINED_ATTR, before?.type === 'quote');
    if (block.type !== 'listItem') {
      counters.length = 0;
      return;
    }
    // A list starts after a non-list block, or where a top-level item switches
    // between numbered and not. The stylesheet puts the block gap above it.
    const ordered = block.listType === 'ordered';
    setFlag(el, LIST_START_ATTR, before?.type !== 'listItem' || (block.indent === 0 && ordered !== (before.listType === 'ordered')));
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
  return leaves(contentEl)
    .map(leafText)
    .join('');
}

function offsetIn(contentEl: HTMLElement, node: Node, offset: number): number {
  if (!contentEl.contains(node)) {
    // A point on a marker or other chrome: before or after the content.
    const before = node.compareDocumentPosition(contentEl) & Node.DOCUMENT_POSITION_FOLLOWING;
    return before ? 0 : leaves(contentEl).reduce((n, l) => n + leafLength(l), 0);
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

export function positionToDom(blockEl: HTMLElement, pos: Position): { node: Node; offset: number } {
  const content = contentElement(blockEl, pos.cell);
  if (!content) {
    // A divider or rendered block: select around it.
    return { node: blockEl.parentNode!, offset: childIndex(blockEl) };
  }
  let acc = 0;
  const all = leaves(content);
  for (const leaf of all) {
    const len = leafLength(leaf);
    if (leaf.nodeType === 3) {
      const text = leaf as Text;
      if (acc + len >= pos.offset) {
        const local = pos.offset - acc;
        // After a trailing line break, put the caret before the filler <br> so it shows on the empty last line.
        if (local === len && leaf === all[all.length - 1] && text.data.endsWith('\n')) {
          const br = content.querySelector(`[${FILL_ATTR}]`);
          if (br) return { node: br.parentNode!, offset: childIndex(br) };
        }
        return { node: text, offset: local };
      }
    } else if (pos.offset < acc + len) {
      // Before an atom, or after a rendered token when the offset falls inside its source.
      return { node: leaf.parentNode!, offset: childIndex(leaf) + (acc === pos.offset ? 0 : 1) };
    }
    acc += len;
  }
  const last = all[all.length - 1];
  if (!last) return { node: content, offset: 0 };
  if (last.nodeType === 3) return { node: last, offset: (last as Text).length };
  return { node: last.parentNode!, offset: childIndex(last) + 1 };
}
