// The resize handles of the hovered or selected image while editing. They
// live in the popup container like the other floating UI, so the document's
// DOM holds only the image.

import type { Editor } from '../editor';
import type { ImageAtom, Position } from '../model';
import { attach } from './popup';

/** The narrowest an image can be resized to, in CSS pixels. */
const MIN_WIDTH = 24;
/** How close a width must come to another image's width or the column's to snap to it. */
const SNAP = 8;
/** The shortest a handle is (`min-height` in base.css): an image clipped to less than that shows no handles. A whole image that small still does, as before. */
const MIN_HANDLE = 16;

type Side = 'left' | 'right';

/** @internal What the editor tells the controls about an image element. */
export interface ImageTarget {
  readonly el: HTMLElement;
  readonly pos: Position;
  readonly image: ImageAtom;
}

export class ResizeHandles {
  /** A frame over the image, holding the two handles. It takes no pointer events itself. */
  private readonly frame: HTMLElement;
  private readonly handles: Record<Side, HTMLElement>;
  /** The image under the pointer, which shows handles while it is hovered. */
  private hovered: HTMLElement | null = null;
  /** The selected image, which shows handles. */
  private selected: ImageTarget | null = null;
  /** The image the frame is shown for. */
  private framed: HTMLElement | null = null;
  private drag: {
    el: HTMLElement;
    side: Side;
    pointer: number;
    startX: number;
    startWidth: number;
    max: number;
    snaps: number[];
    width: number;
    /** 2 for a centered image block, which grows on both sides; else 1. */
    factor: number;
  } | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly editor: Editor) {
    const root = editor.root;
    const doc = root.ownerDocument;
    const labels = editor.labels;

    this.frame = doc.createElement('div');
    this.frame.className = 'mbe-ui mbe-image-frame';
    this.frame.hidden = true;
    const resizeHandle = (side: Side) => {
      const el = doc.createElement('div');
      el.className = `mbe-resize-handle mbe-resize-handle-${side}`;
      el.dataset.side = side;
      el.title = labels.resizeImage;
      el.setAttribute('aria-hidden', 'true');
      this.frame.appendChild(el);
      return el;
    };
    this.handles = { left: resizeHandle('left'), right: resizeHandle('right') };

    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      target.addEventListener(type, fn);
      this.cleanup.push(() => target.removeEventListener(type, fn));
    };
    on(root, 'mouseover', (e) => this.onOver(e));
    on(root, 'mouseleave', () => this.scheduleUnhover());
    // The frame takes no pointer events; its handles do.
    for (const el of [this.frame, this.handles.left, this.handles.right]) {
      on(el, 'mouseenter', () => this.cancelUnhover());
      on(el, 'mouseleave', () => this.scheduleUnhover());
    }
    // Keep focus and the selection in the editor.
    on(this.frame, 'mousedown', (e) => e.preventDefault());
    for (const side of ['left', 'right'] as const) on(this.handles[side], 'pointerdown', (e) => this.startDrag(e, side));
    on(this.frame, 'pointermove', (e) => this.moveDrag(e));
    on(this.frame, 'pointerup', (e) => this.endDrag(e, true));
    on(this.frame, 'pointercancel', (e) => this.endDrag(e, false));
    on(this.frame, 'lostpointercapture', (e) => this.endDrag(e, true));
  }

  /** True when `node` is the frame or one of its resize handles. */
  contains(node: Node): boolean {
    return this.frame.contains(node);
  }

  /** True while a handle is being dragged. */
  get isDragging(): boolean {
    return this.drag !== null;
  }

  /** Shows the handles for the selected image, or for none. */
  update(selected: ImageTarget | null): void {
    this.selected = selected;
    if (!this.drag) this.placeFrame();
  }

  /** Moves the resize handles to where their image is now, after scrolling. */
  reposition(): void {
    if (this.drag) return;
    if (this.selected && !this.selected.el.isConnected) this.selected = null;
    this.placeFrame();
  }

  hide(): void {
    if (this.drag) return;
    this.hovered = null;
    this.selected = null;
    this.placeFrame();
  }

  destroy(): void {
    this.cancelUnhover();
    for (const fn of this.cleanup) fn();
    this.frame.remove();
  }

  // -- Hover ----------------------------------------------------------------

  private onOver(e: MouseEvent): void {
    if (this.drag || !this.editor.isEditable) return;
    const target = e.target as HTMLElement | null;
    const img = target instanceof HTMLImageElement && target.classList.contains('mbe-image') ? target : null;
    if (img) {
      this.cancelUnhover();
      this.hovered = img;
      this.placeFrame();
    } else if (this.hovered) {
      this.scheduleUnhover();
    }
  }

  private scheduleUnhover(): void {
    this.cancelUnhover();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hovered = null;
      this.placeFrame();
    }, 250);
  }

  private cancelUnhover(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  /** Shows the handles over the hovered image, else the selected one. Only images that loaded can be resized. */
  private placeFrame(): void {
    const editable = this.editor.isEditable;
    const hovered = this.hovered?.isConnected ? this.hovered : null;
    const el = this.drag?.el ?? (editable ? (hovered ?? this.selected?.el ?? null) : null);
    const img = el instanceof HTMLImageElement && el.isConnected ? el : null;
    const rect = img?.getBoundingClientRect();
    if (!img || !rect || rect.width === 0 || rect.height === 0) {
      this.frame.hidden = true;
      this.framed = null;
      return;
    }
    if (this.framed !== img) {
      this.framed = img;
      // Its size is known once it loads.
      if (!img.complete) img.addEventListener('load', () => this.framed === img && this.placeFrame(), { once: true });
    }
    // The frame covers only the visible part of the image, so the handles at
    // its middle stay inside the scrolling container that clips the image
    // instead of floating over whatever is below it.
    const shown = visibleRect(img, rect);
    if (!shown || shown.width < Math.min(rect.width, MIN_HANDLE) || shown.height < Math.min(rect.height, MIN_HANDLE)) {
      this.frame.hidden = true;
      return;
    }
    this.frame.hidden = false;
    const offset = attach(this.frame, this.editor.root);
    this.frame.style.left = `${Math.round(shown.left - offset.x)}px`;
    this.frame.style.top = `${Math.round(shown.top - offset.y)}px`;
    this.frame.style.width = `${Math.round(shown.width)}px`;
    this.frame.style.height = `${Math.round(shown.height)}px`;
    this.frame.classList.toggle('mbe-image-frame-small', shown.width < 64 || shown.height < 40);
  }

  // -- Resizing -------------------------------------------------------------

  private startDrag(e: PointerEvent, side: Side): void {
    const el = this.framed;
    if (!el || this.drag || e.button !== 0 || !this.editor.isEditable) return;
    const target = this.editor.imageTarget(el);
    if (!target) return;
    e.preventDefault();
    this.handles[side].setPointerCapture?.(e.pointerId);
    const width = el.getBoundingClientRect().width;
    const others = Array.from(this.editor.root.querySelectorAll<HTMLImageElement>('img.mbe-image'))
      .filter((other) => other !== el)
      .map((other) => other.getBoundingClientRect().width)
      .filter((w) => w > 0);
    const max = Math.max(MIN_WIDTH, columnWidth(el));
    const factor = el.closest('.mbe-image-block')?.getAttribute('data-align') === 'center' ? 2 : 1;
    this.drag = { el, side, pointer: e.pointerId, startX: e.clientX, startWidth: width, max, snaps: [...others, max], width, factor };
    this.frame.classList.add('mbe-image-resizing');
    // Select the image being resized, so the change lands on it and it stays selected.
    this.editor.selectImageAt(target.pos);
  }

  private moveDrag(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointer) return;
    e.preventDefault();
    // The edge being dragged follows the pointer; the image keeps its aspect ratio.
    // A centered image grows on both sides, so its width changes twice as much.
    const dx = (e.clientX - drag.startX) * (drag.side === 'right' ? 1 : -1) * drag.factor;
    let width = Math.min(drag.max, Math.max(MIN_WIDTH, drag.startWidth + dx));
    const snap = drag.snaps.find((w) => Math.abs(w - width) <= SNAP);
    if (snap !== undefined) width = Math.min(drag.max, snap);
    drag.width = Math.round(width);
    drag.el.style.width = `${drag.width}px`;
    drag.el.style.height = 'auto';
    this.placeFrame();
  }

  private endDrag(e: PointerEvent, commit: boolean): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointer) return;
    this.drag = null;
    this.frame.classList.remove('mbe-image-resizing');
    this.handles[drag.side].releasePointerCapture?.(e.pointerId);
    drag.el.style.width = '';
    drag.el.style.height = '';
    const target = drag.el.isConnected ? this.editor.imageTarget(drag.el) : null;
    if (commit && target && Math.round(drag.width) !== Math.round(drag.startWidth)) {
      this.editor.updateImageAt(target.pos, { width: drag.width });
    } else {
      this.editor.refreshImageUi();
    }
  }
}

/**
 * @internal
 * The part of `rect`, the image's rectangle, that its scrolling ancestors and
 * the viewport show, or null when none of it is visible. Ancestors that scroll
 * are detected as in `scrollRectIntoView`; a host with `overflow: hidden` and
 * nothing to scroll is left alone, as it is for the other floating UI.
 */
export function visibleRect(img: HTMLElement, rect: DOMRect): { left: number; top: number; width: number; height: number } | null {
  const doc = img.ownerDocument;
  const view = doc.defaultView;
  let left = rect.left;
  let top = rect.top;
  let right = rect.right;
  let bottom = rect.bottom;
  const clip = (l: number, t: number, r: number, b: number) => {
    left = Math.max(left, l);
    top = Math.max(top, t);
    right = Math.min(right, r);
    bottom = Math.min(bottom, b);
  };
  for (let el = img.parentElement; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    const style = view?.getComputedStyle(el);
    const scrollsY = el.scrollHeight > el.clientHeight && /auto|scroll|overlay/.test(style?.overflowY ?? '');
    const scrollsX = el.scrollWidth > el.clientWidth && /auto|scroll|overlay/.test(style?.overflowX ?? '');
    if (!scrollsY && !scrollsX) continue;
    // The client area, inside the borders and without the scrollbars.
    const box = el.getBoundingClientRect();
    const viewLeft = box.left + el.clientLeft;
    const viewTop = box.top + el.clientTop;
    clip(viewLeft, viewTop, viewLeft + el.clientWidth, viewTop + el.clientHeight);
  }
  clip(0, 0, doc.documentElement.clientWidth, doc.documentElement.clientHeight);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** The width an image can grow to: its line's width inside the block or table cell. */
function columnWidth(el: HTMLElement): number {
  let box = el.parentElement;
  const view = el.ownerDocument.defaultView!;
  while (box && view.getComputedStyle(box).display.startsWith('inline')) box = box.parentElement;
  if (!box) return el.getBoundingClientRect().width;
  const cs = view.getComputedStyle(box);
  return box.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
}
