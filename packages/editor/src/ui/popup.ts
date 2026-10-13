// Floating UI: a positioned layer and a keyboard-navigable menu.
//
// Popups use `position: fixed` and are appended to document.body, so a host
// container with `overflow: hidden` (a chat input, a card) does not clip
// them. Inside an open <dialog> or an `aria-modal` element they are appended
// there instead, so they show above the modal and stay usable; the
// `popupContainer` option picks the element. Theme variables are copied from
// the editor root when a popup opens.

import { type Icon, iconNode } from '../icons';

const THEME_VARS = [
  '--mbe-font',
  '--mbe-mono',
  '--mbe-text',
  '--mbe-muted',
  '--mbe-bg',
  '--mbe-popup-bg',
  '--mbe-popup-border',
  '--mbe-popup-shadow',
  '--mbe-hover',
  '--mbe-accent',
  '--mbe-danger',
  '--mbe-radius',
  '--mbe-popup-z',
];

export type Placement = 'below' | 'above';

const containers = new WeakMap<HTMLElement, HTMLElement>();

/** Sets the element an editor's popups are appended to (the `popupContainer` option). */
export function setPopupContainer(owner: HTMLElement, container: HTMLElement | undefined): void {
  if (container) containers.set(owner, container);
  else containers.delete(owner);
}

/** Where the popups of the editor `owner` go: `popupContainer`, else the nearest open dialog or `aria-modal` ancestor, else the body. */
export function popupContainer(owner: HTMLElement): HTMLElement {
  return containers.get(owner) ?? owner.closest<HTMLElement>('dialog[open], [aria-modal="true"]') ?? owner.ownerDocument.body;
}

/**
 * Appends a shown `position: fixed` element to its container, and returns
 * the offset of its containing block. The offset is not zero when an
 * ancestor has a `transform`, `filter` or `contain` style, which makes
 * `position: fixed` relative to that ancestor instead of the viewport.
 */
export function attach(el: HTMLElement, owner: HTMLElement): { x: number; y: number } {
  const container = popupContainer(owner);
  if (el.parentElement !== container) container.appendChild(el);
  el.style.left = '0px';
  el.style.top = '0px';
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.top };
}

/** The visible part of the layout viewport, which the on-screen keyboard can shrink. */
export function visibleViewport(view: Window): { left: number; top: number; width: number; height: number } {
  const vv = view.visualViewport;
  return vv
    ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
    : { left: 0, top: 0, width: view.innerWidth, height: view.innerHeight };
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);

/** Safari, which sends the Enter that commits a composition after `compositionend`. */
export const isSafari = typeof navigator !== 'undefined' && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(navigator.userAgent);

/** True on touch devices, which have no hover and show their own menu over a selection. */
export const isTouch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export class Popup {
  readonly el: HTMLElement;
  private open = false;
  private placed: Placement = 'below';

  constructor(
    private readonly owner: HTMLElement,
    className: string,
  ) {
    const doc = owner.ownerDocument;
    this.el = doc.createElement('div');
    this.el.className = `mbe-ui ${className}`;
    this.el.hidden = true;
    // Clicks inside a popup must not take focus or the selection away from the editor.
    this.el.addEventListener('mousedown', (e) => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** The side of the anchor the popup was last shown on. */
  get side(): Placement {
    return this.placed;
  }

  /**
   * Shows the popup next to `rect` (viewport coordinates), flipping to stay
   * on screen. With `align: 'end'`, its right edge lines up with `rect.right`
   * (for right-to-left text).
   */
  show(
    rect: { left: number; top: number; bottom: number; right?: number },
    placement: Placement = 'below',
    gap = 6,
    align: 'start' | 'end' = 'start',
  ): void {
    const doc = this.owner.ownerDocument;
    if (!this.open) this.copyTheme();
    this.el.hidden = false;
    this.open = true;
    const offset = attach(this.el, this.owner);

    const view = doc.defaultView!;
    const vp = visibleViewport(view);
    // Where it does not fit, it goes on the side with more room and scrolls,
    // as on a phone with the keyboard open.
    // Measured at full height; keep the scroll position when it shrinks again.
    const scrolled = this.el.scrollTop;
    this.el.style.maxHeight = '';
    const w = this.el.offsetWidth;
    let h = this.el.offsetHeight;
    const below = vp.top + vp.height - 8 - (rect.bottom + gap);
    const above = rect.top - gap - 8 - vp.top;
    let side = placement;
    if (side === 'below' && h > below && above > below) side = 'above';
    else if (side === 'above' && h > above && below > above) side = 'below';
    const room = side === 'below' ? below : above;
    if (h > room) {
      // With content-box sizing, max-height leaves out padding and borders.
      const cs = view.getComputedStyle(this.el);
      const extra =
        cs.boxSizing === 'border-box'
          ? 0
          : ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((n, k) => n + parseFloat(cs[k as 'paddingTop']), 0);
      this.el.style.maxHeight = `${Math.max(Math.floor(room - extra), 80)}px`;
      h = this.el.offsetHeight;
      this.el.scrollTop = scrolled;
    }
    this.placed = side;
    const top = side === 'below' ? rect.bottom + gap : rect.top - h - gap;
    const start = align === 'end' ? (rect.right ?? rect.left) - w : rect.left;
    const left = Math.max(vp.left + 8, Math.min(start, vp.left + vp.width - w - 8));
    this.el.style.left = `${Math.round(left - offset.x)}px`;
    this.el.style.top = `${Math.round(top - offset.y)}px`;
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.el.hidden = true;
  }

  destroy(): void {
    this.el.remove();
  }

  private copyTheme(): void {
    const style = this.owner.ownerDocument.defaultView!.getComputedStyle(this.owner);
    for (const name of THEME_VARS) {
      const value = style.getPropertyValue(name);
      if (value) this.el.style.setProperty(name, value);
    }
    // Colors are light-dark() values, so the popup needs the root's color scheme too.
    this.el.style.colorScheme = style.colorScheme;
  }
}

export interface MenuItem {
  id: string;
  label: string;
  /** Secondary text after the label. */
  detail?: string;
  /** Text in the label to mark (the query): its first case-insensitive occurrence. */
  mark?: string;
  /** Shown before the label: text, or an element that is cloned. */
  icon?: Icon;
  /** Extra words that match when filtering. */
  aliases?: string[];
  danger?: boolean;
  run: () => void;
}

export interface MenuSection {
  title?: string;
  items: MenuItem[];
}

let menuCounter = 0;

/** A list of options with a highlighted item, driven by the keyboard (`aria-activedescendant`) or the mouse. */
export class Menu {
  readonly popup: Popup;
  private items: MenuItem[] = [];
  private index = 0;
  private readonly id = `mbe-menu-${++menuCounter}`;
  /** Called after an item runs. */
  onPicked: (() => void) | null = null;
  /** Called when the highlight moves, by key, by mouse or because the items changed. */
  onHighlight: ((index: number) => void) | null = null;

  constructor(owner: HTMLElement, className: string, role: 'listbox' | 'menu' = 'listbox') {
    this.popup = new Popup(owner, `mbe-menu ${className}`);
    this.popup.el.setAttribute('role', role);
    this.popup.el.id = this.id;
  }

  get el(): HTMLElement {
    return this.popup.el;
  }

  get isOpen(): boolean {
    return this.popup.isOpen;
  }

  get activeDescendant(): string | null {
    return this.items.length ? `${this.id}-${this.index}` : null;
  }

  setSections(sections: MenuSection[], emptyLabel?: string): void {
    const doc = this.el.ownerDocument;
    this.el.replaceChildren();
    this.items = [];
    this.index = 0;
    for (const section of sections) {
      if (section.items.length === 0) continue;
      if (section.title) {
        const title = doc.createElement('div');
        title.className = 'mbe-menu-title';
        title.textContent = section.title;
        title.setAttribute('role', 'presentation');
        this.el.appendChild(title);
      }
      for (const item of section.items) {
        const i = this.items.length;
        this.items.push(item);
        const row = doc.createElement('div');
        row.className = 'mbe-menu-item';
        row.id = `${this.id}-${i}`;
        row.setAttribute('role', this.el.getAttribute('role') === 'menu' ? 'menuitem' : 'option');
        if (item.danger) row.classList.add('mbe-danger');
        const icon = doc.createElement('span');
        icon.className = 'mbe-menu-icon';
        const content = iconNode(doc, item.icon);
        if (content) icon.appendChild(content);
        const label = doc.createElement('span');
        label.className = 'mbe-menu-label';
        setMarked(label, item.label, item.mark);
        row.append(icon, label);
        if (item.detail) {
          const detail = doc.createElement('span');
          detail.className = 'mbe-menu-detail';
          detail.textContent = item.detail;
          row.appendChild(detail);
        }
        row.addEventListener('mousemove', () => this.highlight(i));
        row.addEventListener('click', () => this.pick(i));
        this.el.appendChild(row);
      }
    }
    if (this.items.length === 0 && emptyLabel) {
      const empty = doc.createElement('div');
      empty.className = 'mbe-menu-empty';
      empty.textContent = emptyLabel;
      this.el.appendChild(empty);
    }
    this.highlight(0);
  }

  /** Replaces the items with a line of text that is not an option, such as "Loading…". */
  setMessage(text: string, className: string): void {
    const doc = this.el.ownerDocument;
    const line = doc.createElement('div');
    line.className = className;
    line.textContent = text;
    this.el.replaceChildren(line);
    this.items = [];
    this.index = 0;
  }

  /** Marks the list as waiting for newer items (`aria-busy`). */
  set busy(busy: boolean) {
    if (busy) this.el.setAttribute('aria-busy', 'true');
    else this.el.removeAttribute('aria-busy');
  }

  get count(): number {
    return this.items.length;
  }

  /** The ID of the highlighted item. */
  get activeId(): string | null {
    return this.items[this.index]?.id ?? null;
  }

  /** Highlights the item with this ID. Returns false when there is none. */
  highlightId(id: string): boolean {
    const i = this.items.findIndex((item) => item.id === id);
    if (i < 0) return false;
    this.highlight(i);
    return true;
  }

  /** Moves the highlight by a page: the number of items that fit in the list's height. Stops at the ends. */
  page(direction: 1 | -1): void {
    const row = this.el.querySelector<HTMLElement>('.mbe-menu-item');
    const perPage = row && row.offsetHeight > 0 ? Math.max(1, Math.floor(this.el.clientHeight / row.offsetHeight) - 1) : 8;
    this.highlight(Math.max(0, Math.min(this.items.length - 1, this.index + direction * perPage)));
  }

  highlight(i: number): void {
    if (this.items.length === 0) return;
    this.index = (i + this.items.length) % this.items.length;
    this.el.querySelectorAll('.mbe-menu-item').forEach((row, k) => {
      row.classList.toggle('mbe-highlighted', k === this.index);
      row.setAttribute('aria-selected', String(k === this.index));
    });
    this.el.querySelector(`#${this.id}-${this.index}`)?.scrollIntoView?.({ block: 'nearest' });
    this.onHighlight?.(this.index);
  }

  /** The index of the highlighted item. */
  get activeIndex(): number {
    return this.items.length ? this.index : -1;
  }

  move(delta: number): void {
    this.highlight(this.index + delta);
  }

  pick(i = this.index): void {
    const item = this.items[i];
    if (!item) return;
    item.run();
    this.onPicked?.();
  }

  hide(): void {
    this.popup.hide();
  }

  destroy(): void {
    this.popup.destroy();
  }
}

/** Sets `el`'s text to `text`, with the first case-insensitive occurrence of `mark` in a `<mark>`. */
function setMarked(el: HTMLElement, text: string, mark: string | undefined): void {
  const at = mark ? text.toLowerCase().indexOf(mark.toLowerCase()) : -1;
  // Lower-casing can change the length of some characters; then mark nothing.
  if (at < 0 || text.toLowerCase().length !== text.length) {
    el.textContent = text;
    return;
  }
  const doc = el.ownerDocument;
  const m = doc.createElement('mark');
  m.className = 'mbe-menu-match';
  m.textContent = text.slice(at, at + mark!.length);
  el.replaceChildren(text.slice(0, at), m, text.slice(at + mark!.length));
}

/** Case-insensitive match of a query against an item's label and aliases (a substring, also with spaces ignored). */
export function matches(item: Pick<MenuItem, 'label' | 'aliases'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const words = [item.label, ...(item.aliases ?? [])].map((w) => w.toLowerCase());
  return words.some((w) => w.includes(q) || w.replace(/\s+/g, '').includes(q.replace(/\s+/g, '')));
}
