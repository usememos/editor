// The block handle shown to the left of the hovered table, code block or image block.
// Clicking it opens the block menu. On touch devices it follows the block
// with the caret. Other blocks have no block handle.

import type { Editor } from '../editor';
import { iconNode } from '../icons';
import { BLOCK_ATTR } from '../view/dom';
import { attach } from './popup';

export class BlockHandle {
  private readonly el: HTMLButtonElement;
  private blockId: string | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly editor: Editor) {
    const root = editor.root;
    const doc = root.ownerDocument;
    this.el = doc.createElement('button');
    this.el.type = 'button';
    this.el.className = 'mbe-ui mbe-block-handle';
    const icon = iconNode(doc, editor.icon('blockHandle'));
    if (icon) this.el.appendChild(icon);
    this.el.setAttribute('aria-label', editor.labels.blockHandle);
    this.el.setAttribute('aria-haspopup', 'menu');
    this.el.tabIndex = -1;
    this.el.hidden = true;

    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      target.addEventListener(type, fn);
      this.cleanup.push(() => target.removeEventListener(type, fn));
    };
    on(root, 'mousemove', (e) => this.onMove(e));
    on(root, 'mouseleave', () => this.scheduleHide());
    on(this.el, 'mouseenter', () => this.cancelHide());
    on(this.el, 'mouseleave', () => this.scheduleHide());
    // Keep focus and the selection in the editor.
    on(this.el, 'mousedown', (e) => e.preventDefault());
    on(this.el, 'click', () => {
      if (this.blockId) editor.openBlockMenu(this.blockId, this.el.getBoundingClientRect());
    });
  }

  private onMove(e: MouseEvent): void {
    if (!this.editor.isEditable) return;
    const target = e.target as Element | null;
    let node: Element | null = target;
    while (node && node.parentElement !== this.editor.root) node = node.parentElement;
    if (!node || !node.hasAttribute(BLOCK_ATTR)) return;
    const blockId = node.getAttribute(BLOCK_ATTR)!;
    if (this.editor.hasBlockMenu(blockId)) this.showFor(blockId);
    else if (this.blockId !== null) this.scheduleHide();
  }

  /** Shows the block handle next to a block. */
  showFor(blockId: string): void {
    this.cancelHide();
    const blockEl = this.editor.blockElement(blockId);
    if (!blockEl) return this.hide();
    const doc = this.editor.root.ownerDocument;
    this.blockId = blockId;
    this.el.hidden = false;
    const offset = attach(this.el, this.editor.root);
    const rect = blockEl.getBoundingClientRect();
    // Center on the first line of the block.
    const lineHeight = parseFloat(doc.defaultView!.getComputedStyle(blockEl).lineHeight) || 24;
    const firstLine = Math.min(rect.height, lineHeight);
    const size = this.el.offsetHeight || 22;
    this.el.style.left = `${Math.round(rect.left - (this.el.offsetWidth || 20) - 6 - offset.x)}px`;
    this.el.style.top = `${Math.round(rect.top + firstLine / 2 - size / 2 - offset.y)}px`;
  }

  /** True when `node` is the block handle or inside it. */
  contains(node: Node): boolean {
    return this.el.contains(node);
  }

  hide(): void {
    this.cancelHide();
    this.el.hidden = true;
    this.blockId = null;
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => this.hide(), 250);
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  destroy(): void {
    this.cancelHide();
    for (const fn of this.cleanup) fn();
    this.el.remove();
  }
}
