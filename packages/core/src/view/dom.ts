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
  inlineLength,
} from '../model';
import type { Labels } from '../labels';
import { type Decoration, decorationContext, splitByDecorations } from '../decorations';

export const BLOCK_ATTR = 'data-block-id';
const CONTENT_ATTR = 'data-content';
const FILL_ATTR = 'data-mbe-fill';
const ATOM_ATTR = 'data-atom';

const MARK_TAGS: Record<Mark, [string, string?]> = {
  bold: ['strong'],
  italic: ['em'],
  strike: ['s'],
  code: ['code'],
  html: ['span', 'mbe-raw-html'],
};

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
}

function renderBlock(block: Block, ctx: RenderContext): HTMLElement {
  const { doc, labels } = ctx;
  const el = (tag: string, className?: string) => {
    const e = doc.createElement(tag);
    if (className) e.className = className;
    return e;
  };
  let root: HTMLElement;
  switch (block.type) {
    case 'paragraph':
      root = el('p');
      fillContent(root, block.content, ctx, block);
      break;
    case 'heading':
      root = el(`h${block.level}`);
      fillContent(root, block.content, ctx, block);
      break;
    case 'quote':
      root = el('blockquote');
      fillContent(root, block.content, ctx, block);
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
      fillContent(content, block.content, ctx, block);
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
      bar.appendChild(lang);
      const pre = el('pre');
      const code = el('code');
      code.spellcheck = false;
      fillContent(code, block.content, ctx);
      pre.appendChild(code);
      root.append(bar, pre);
      break;
    }
    case 'raw':
      root = el('pre');
      root.dataset.syntax = block.syntax;
      root.spellcheck = false;
      fillContent(root, block.content, ctx);
      break;
    case 'divider':
      root = el('div');
      root.contentEditable = 'false';
      root.appendChild(el('hr'));
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
          fillContent(td, cell, ctx, block, { row: r, col: c });
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
  root.className = className;
  return root;
}

/** `block` is given for containers that take decorations (not code or raw blocks). */
function fillContent(target: HTMLElement, inline: Inline, ctx: RenderContext, block?: Block, cell?: Cell): void {
  const doc = ctx.doc;
  target.setAttribute(CONTENT_ATTR, '');
  if (inlineLength(inline) === 0) {
    target.classList.add('mbe-empty-content');
    // An empty block needs a <br> so it has height and can hold the caret.
    target.appendChild(fill(doc));
    return;
  }
  const decorations = block && ctx.decorate ? ctx.decorate(block, inline, cell) : [];
  renderInline(inline, target, ctx, decorations);
  // A trailing line break needs a <br> after it to show the empty last line.
  const last = inline[inline.length - 1];
  if (last && last.text.endsWith('\n')) target.appendChild(fill(doc));
}

function fill(doc: Document): HTMLElement {
  const br = doc.createElement('br');
  br.setAttribute(FILL_ATTR, '');
  return br;
}

function renderInline(inline: Inline, parent: HTMLElement, ctx: RenderContext, decorations: readonly Decoration[] = []): void {
  const doc = ctx.doc;
  const pieces = splitByDecorations(inline, decorations);
  const render = (piece: (typeof pieces)[number]) => decorate(renderSpan(piece.span, ctx), piece.decorations, doc);
  // Consecutive spans with the same link share one <a>.
  let i = 0;
  while (i < pieces.length) {
    const span = pieces[i]!.span;
    if (span.link) {
      const a = doc.createElement('a');
      const href = safeHref(span.link);
      if (href !== null) a.setAttribute('href', href);
      a.dataset.href = span.link;
      a.className = 'mbe-link';
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

function renderSpan(span: Span, ctx: RenderContext): Node {
  const doc = ctx.doc;
  if (span.image) {
    const img = doc.createElement('img');
    const src = safeHref(ctx.resolveImageSrc ? ctx.resolveImageSrc(span.image.src) : span.image.src);
    if (src !== null) img.src = src;
    img.alt = span.image.alt;
    if (span.image.title) img.title = span.image.title;
    img.setAttribute(ATOM_ATTR, '');
    img.contentEditable = 'false';
    img.className = 'mbe-image';
    return img;
  }
  let node: Node = doc.createTextNode(span.text);
  if (span.token) {
    // A token of a syntax extension, shown as its source.
    const wrapper = doc.createElement('span');
    wrapper.className = `mbe-token mbe-token-${span.token}`;
    wrapper.spellcheck = false;
    wrapper.appendChild(node);
    node = wrapper;
  }
  // Innermost mark first, so the outer order matches MARK_ORDER.
  for (let i = MARK_ORDER.length - 1; i >= 0; i--) {
    const mark = MARK_ORDER[i]!;
    if (!span.marks.includes(mark)) continue;
    const [tag, cls] = MARK_TAGS[mark];
    const wrapper = doc.createElement(tag);
    if (cls) wrapper.className = cls;
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
  private rendered = new Map<string, { block: Block; el: HTMLElement }>();
  /** Last number written into each ordered item's marker, keyed by element. */
  private readonly numbers = new WeakMap<HTMLElement, number>();

  /** Maps an image `src` to the URL to display. Set before a full render. */
  resolveImageSrc?: (src: string) => string;
  /** Decorations for a text container. */
  decorate?: RenderContext['decorate'];
  /** Widget elements to place after a block. */
  widgetsAfter?: (blockId: string) => readonly HTMLElement[] | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly labels: Labels,
  ) {}

  private context(): RenderContext {
    return { doc: this.root.ownerDocument, labels: this.labels, resolveImageSrc: this.resolveImageSrc, decorate: this.decorate };
  }

  /**
   * `force` re-renders every block. `lazy` (with a full render) lets blocks
   * skip layout while off screen; use it only when loading a document.
   */
  render(doc: Doc, force = false, lazy = false): void {
    const ctx = this.context();
    const next = new Map<string, { block: Block; el: HTMLElement }>();
    for (const block of doc.blocks) {
      const prev = this.rendered.get(block.id);
      const reuse = !force && prev && prev.block === block && prev.el.parentNode === this.root;
      next.set(block.id, { block, el: reuse ? prev.el : renderBlock(block, ctx) });
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
    updateListNumbers(doc, (id) => next.get(id)?.el, this.numbers);
  }

  elementFor(id: string): HTMLElement | undefined {
    return this.rendered.get(id)?.el;
  }

  /** Forget a block's element so the next render rebuilds it, e.g. after the browser edited it during IME composition. */
  invalidate(id: string): void {
    this.rendered.delete(id);
  }
}

/** Numbers ordered list items. Runs after every render, because a number depends on the items above. */
function updateListNumbers(
  doc: Doc,
  elementFor: (id: string) => HTMLElement | undefined,
  written: WeakMap<HTMLElement, number>,
): void {
  const counters: (number | undefined)[] = [];
  for (const block of doc.blocks) {
    if (block.type !== 'listItem') {
      counters.length = 0;
      continue;
    }
    counters.length = block.indent + 1;
    if (block.listType !== 'ordered') {
      counters[block.indent] = undefined;
      continue;
    }
    const n = counters[block.indent] === undefined ? (block.start ?? 1) : counters[block.indent]! + 1;
    counters[block.indent] = n;
    const el = elementFor(block.id);
    if (!el || written.get(el) === n) continue;
    const marker = el.querySelector('.mbe-marker');
    if (marker) marker.textContent = `${n}.`;
    written.set(el, n);
  }
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

/** Text nodes and atoms (images) inside a content element, in order. Each atom counts as one character. */
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

function leafLength(leaf: Text | HTMLElement): number {
  return leaf.nodeType === 3 ? (leaf as Text).length : 1;
}

/** Plain text of a content element as the browser currently has it, with atoms as one character. */
export function domText(contentEl: HTMLElement): string {
  return leaves(contentEl)
    .map((l) => (l.nodeType === 3 ? (l as Text).data : '￼'))
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
    // A divider: select around it.
    const parent = blockEl.parentNode!;
    return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, blockEl) };
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
          if (br) return { node: br.parentNode!, offset: Array.prototype.indexOf.call(br.parentNode!.childNodes, br) };
        }
        return { node: text, offset: local };
      }
    } else if (acc === pos.offset) {
      const parent = leaf.parentNode!;
      return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, leaf) };
    }
    acc += len;
  }
  const last = all[all.length - 1];
  if (!last) return { node: content, offset: 0 };
  if (last.nodeType === 3) return { node: last, offset: (last as Text).length };
  const parent = last.parentNode!;
  return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, last) + 1 };
}
