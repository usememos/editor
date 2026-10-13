// Scrolling a rectangle, such as the caret, into view.

/** Space kept between the rectangle and the edge it is scrolled to, in pixels. */
const MARGIN = 8;

/**
 * Scrolls `from` and each of its ancestors that scroll, then the window, by the least
 * amount that shows `rect`. Like `scrollIntoView({ block: 'nearest' })`, but
 * for a rectangle, so a caret inside a tall block is shown, not the block's top.
 */
export function scrollRectIntoView(from: Element, rect: DOMRect): void {
  const doc = from.ownerDocument;
  const win = doc.defaultView;
  let top = rect.top;
  let bottom = rect.bottom;
  let left = rect.left;
  let right = rect.right;
  for (let el: Element | null = from; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    const style = win?.getComputedStyle(el);
    const scrollsY = el.scrollHeight > el.clientHeight && /auto|scroll|overlay/.test(style?.overflowY ?? '');
    const scrollsX = el.scrollWidth > el.clientWidth && /auto|scroll|overlay/.test(style?.overflowX ?? '');
    if (!scrollsY && !scrollsX) continue;
    const box = el.getBoundingClientRect();
    // The client area, inside the borders.
    const viewTop = box.top + el.clientTop;
    const viewLeft = box.left + el.clientLeft;
    const dy = scrollsY ? delta(top, bottom, viewTop, viewTop + el.clientHeight) : 0;
    const dx = scrollsX ? delta(left, right, viewLeft, viewLeft + el.clientWidth) : 0;
    if (!dy && !dx) continue;
    const beforeTop = el.scrollTop;
    const beforeLeft = el.scrollLeft;
    el.scrollTop += dy;
    el.scrollLeft += dx;
    // What actually moved: a container can stop at its end.
    top -= el.scrollTop - beforeTop;
    bottom -= el.scrollTop - beforeTop;
    left -= el.scrollLeft - beforeLeft;
    right -= el.scrollLeft - beforeLeft;
  }
  if (!win) return;
  const viewport = doc.documentElement;
  const dy = delta(top, bottom, 0, viewport.clientHeight);
  const dx = delta(left, right, 0, viewport.clientWidth);
  if (dy || dx) win.scrollBy(dx, dy);
}

/** How far to scroll so that [start, end] sits inside [viewStart, viewEnd]. */
function delta(start: number, end: number, viewStart: number, viewEnd: number): number {
  if (start < viewStart + MARGIN) return start - viewStart - MARGIN;
  if (end > viewEnd - MARGIN) return Math.min(end - viewEnd + MARGIN, start - viewStart - MARGIN);
  return 0;
}
