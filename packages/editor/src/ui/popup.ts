// Floating UI: a positioned layer and a keyboard-navigable menu.
//
// Popups are appended to document.body with `position: fixed`, so a host
// container with `overflow: hidden` (a chat input, a card) does not clip
// them. Theme variables are copied from the editor root when a popup opens.

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
];

type Placement = 'below' | 'above';

export const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);

/** True on touch devices, which have no hover and show their own menu over a selection. */
export const isTouch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export class Popup {
  readonly el: HTMLElement;
  private open = false;

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

  /** Shows the popup next to `rect` (viewport coordinates), flipping to stay on screen. */
  show(rect: { left: number; top: number; bottom: number; right?: number }, placement: Placement = 'below', gap = 6): void {
    const doc = this.owner.ownerDocument;
    if (!this.el.isConnected) doc.body.appendChild(this.el);
    if (!this.open) this.copyTheme();
    this.el.hidden = false;
    this.open = true;

    const view = doc.defaultView!;
    // Where it does not fit, it goes on the side with more room and scrolls,
    // as on a phone with the keyboard open.
    // Measured at full height; keep the scroll position when it shrinks again.
    const scrolled = this.el.scrollTop;
    this.el.style.maxHeight = '';
    const w = this.el.offsetWidth;
    let h = this.el.offsetHeight;
    const below = view.innerHeight - 8 - (rect.bottom + gap);
    const above = rect.top - gap - 8;
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
    const top = side === 'below' ? rect.bottom + gap : rect.top - h - gap;
    const left = Math.max(8, Math.min(rect.left, view.innerWidth - w - 8));
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
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
        label.textContent = item.label;
        row.append(icon, label);
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

  get count(): number {
    return this.items.length;
  }

  highlight(i: number): void {
    if (this.items.length === 0) return;
    this.index = (i + this.items.length) % this.items.length;
    this.el.querySelectorAll('.mbe-menu-item').forEach((row, k) => {
      row.classList.toggle('mbe-highlighted', k === this.index);
      row.setAttribute('aria-selected', String(k === this.index));
    });
    this.el.querySelector(`#${this.id}-${this.index}`)?.scrollIntoView?.({ block: 'nearest' });
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

/** Case-insensitive match of a query against an item's label and aliases (a substring, also with spaces ignored). */
export function matches(item: Pick<MenuItem, 'label' | 'aliases'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const words = [item.label, ...(item.aliases ?? [])].map((w) => w.toLowerCase());
  return words.some((w) => w.includes(q) || w.replace(/\s+/g, '').includes(q.replace(/\s+/g, '')));
}
