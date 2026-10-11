// Rendering blocks to DOM, and mapping between DOM points and model positions.

import { type Block, type Doc, type Inline, type Mark, type Position, MARK_ORDER, inlineLength } from '../model';

export const BLOCK_ATTR = 'data-block-id';

const MARK_TAGS: Record<Mark, string> = { bold: 'strong', italic: 'em', strike: 's', code: 'code' };

export function renderBlock(block: Block, doc: Document = document): HTMLElement {
  const tag = block.type === 'heading' ? `h${block.level}` : 'p';
  const el = doc.createElement(tag);
  el.setAttribute(BLOCK_ATTR, block.id);
  el.className = `mbe-block mbe-${block.type}`;
  if (inlineLength(block.content) === 0) {
    el.classList.add('mbe-empty');
    // An empty block needs a <br> so it has height and can hold the caret.
    el.appendChild(doc.createElement('br'));
  } else {
    renderInline(block.content, el, doc);
  }
  return el;
}

function renderInline(inline: Inline, parent: HTMLElement, doc: Document): void {
  for (const span of inline) {
    let node: Node = doc.createTextNode(span.text);
    // Innermost mark first, so the outer order matches MARK_ORDER.
    for (let i = MARK_ORDER.length - 1; i >= 0; i--) {
      const mark = MARK_ORDER[i]!;
      if (!span.marks.includes(mark)) continue;
      const wrapper = doc.createElement(MARK_TAGS[mark]);
      wrapper.appendChild(node);
      node = wrapper;
    }
    parent.appendChild(node);
  }
}

/**
 * Keyed reconciliation. Blocks are immutable, so a block whose object is the
 * same as last render keeps its DOM element untouched.
 */
export class BlockRenderer {
  private rendered = new Map<string, { block: Block; el: HTMLElement }>();

  constructor(private readonly root: HTMLElement) {}

  render(doc: Doc, force = false): void {
    const next = new Map<string, { block: Block; el: HTMLElement }>();
    for (const block of doc.blocks) {
      const prev = this.rendered.get(block.id);
      const el = !force && prev && prev.block === block && prev.el.parentNode === this.root ? prev.el : renderBlock(block, this.root.ownerDocument);
      next.set(block.id, { block, el });
    }

    let ref: ChildNode | null = this.root.firstChild;
    for (const { el } of next.values()) {
      if (el === ref) {
        ref = ref.nextSibling;
      } else {
        this.root.insertBefore(el, ref);
      }
    }
    // Remove stale blocks and anything the browser inserted on its own.
    const keep = new Set<Node>([...next.values()].map((v) => v.el));
    for (const child of Array.from(this.root.childNodes)) {
      if (!keep.has(child)) child.remove();
    }
    this.rendered = next;
  }

  elementFor(id: string): HTMLElement | undefined {
    return this.rendered.get(id)?.el;
  }

  /** Forget a block's element so the next render rebuilds it, e.g. after the browser edited it during IME composition. */
  invalidate(id: string): void {
    this.rendered.delete(id);
  }
}

export function blockElementOf(root: HTMLElement, node: Node): HTMLElement | null {
  let n: Node | null = node;
  while (n && n.parentNode !== root) n = n.parentNode;
  return n instanceof HTMLElement && n.hasAttribute(BLOCK_ATTR) ? n : null;
}

/** Plain text of a rendered block as the browser currently has it. */
export function domText(blockEl: HTMLElement): string {
  return blockEl.textContent ?? '';
}

export function domToPosition(root: HTMLElement, node: Node, offset: number): Position | null {
  if (node === root) {
    const blocks = Array.from(root.children).filter((c): c is HTMLElement => c.hasAttribute(BLOCK_ATTR));
    if (blocks.length === 0) return null;
    if (offset >= blocks.length) {
      const last = blocks[blocks.length - 1]!;
      return { blockId: last.getAttribute(BLOCK_ATTR)!, offset: domText(last).length };
    }
    return { blockId: blocks[offset]!.getAttribute(BLOCK_ATTR)!, offset: 0 };
  }
  const blockEl = blockElementOf(root, node);
  if (!blockEl) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(blockEl, 0);
  range.setEnd(node, offset);
  return { blockId: blockEl.getAttribute(BLOCK_ATTR)!, offset: range.toString().length };
}

export function positionToDom(blockEl: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = blockEl.ownerDocument.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let last: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    if (acc + text.length >= offset) return { node: text, offset: offset - acc };
    acc += text.length;
    last = text;
  }
  return last ? { node: last, offset: last.length } : { node: blockEl, offset: 0 };
}
