// Where the suggestion popup goes: under the caret's line, with its start
// edge at the trigger's start edge, so it does not move sideways while the
// query is typed. Hidden while the trigger is scrolled out of view.

export interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface Anchor {
  /** The rect to place the popup next to: the caret's line, at the trigger's x. */
  readonly rect: Box;
  /** `end` lines up the popup's right edge (right-to-left text). */
  readonly align: 'start' | 'end';
}

/**
 * The popup's anchor from the trigger character's rect and the caret's.
 * Null when the trigger is outside `visible`. When the token wraps, so the
 * trigger is on an earlier line than the caret, the popup lines up with the
 * caret instead.
 */
export function suggestionAnchor(trigger: Box | null, caret: Box | null, rtl: boolean, visible: Box | null): Anchor | null {
  const line = caret ?? trigger;
  if (!line) return null;
  if (trigger && visible && (trigger.bottom <= visible.top || trigger.top >= visible.bottom || trigger.right < visible.left || trigger.left > visible.right)) {
    return null;
  }
  const sameLine = trigger && caret && Math.abs(trigger.top - caret.top) < Math.max(1, Math.min(trigger.bottom - trigger.top, caret.bottom - caret.top) / 2);
  const from = trigger && (sameLine || !caret) ? trigger : line;
  const x = rtl ? from.right : from.left;
  return { rect: { left: x, right: x, top: line.top, bottom: line.bottom }, align: rtl ? 'end' : 'start' };
}

/** The part of the viewport where `el` can show content: inside every ancestor that clips or scrolls. */
export function visibleArea(el: HTMLElement): Box {
  const view = el.ownerDocument.defaultView!;
  let box: Box = { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
  const top = el.ownerDocument.documentElement;
  for (let node: HTMLElement | null = el; node && node !== top && node !== el.ownerDocument.body; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const r = node.getBoundingClientRect();
    box = { left: Math.max(box.left, r.left), top: Math.max(box.top, r.top), right: Math.min(box.right, r.right), bottom: Math.min(box.bottom, r.bottom) };
  }
  return box;
}
