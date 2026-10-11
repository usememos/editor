// The floating formatting toolbar shown over selected text, and the link input.

import type { Editor } from '../editor';
import type { Mark } from '../model';
import { Menu, Popup, isMac, isTouch } from './popup';

const mod = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);

interface MarkButton {
  mark: Mark;
  label: 'bold' | 'italic' | 'strike' | 'inlineCode';
  text: string;
  shortcut: string;
}

const MARK_BUTTONS: MarkButton[] = [
  { mark: 'bold', label: 'bold', text: 'B', shortcut: mod('B') },
  { mark: 'italic', label: 'italic', text: 'I', shortcut: mod('I') },
  { mark: 'strike', label: 'strike', text: 'S', shortcut: isMac ? '⌘⇧X' : 'Ctrl+Shift+X' },
  { mark: 'code', label: 'inlineCode', text: '</>', shortcut: mod('E') },
];

export class BlockToolbar {
  private readonly popup: Popup;
  private readonly typeButton: HTMLButtonElement;
  private readonly markButtons = new Map<Mark, HTMLButtonElement>();
  private readonly linkButton: HTMLButtonElement;
  private readonly typeMenu: Menu;

  constructor(private readonly editor: Editor) {
    const doc = editor.root.ownerDocument;
    this.popup = new Popup(editor.root, 'mbe-toolbar');
    const el = this.popup.el;
    el.setAttribute('role', 'toolbar');

    const button = (text: string, label: string, className: string, onClick: () => void) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `mbe-tool ${className}`;
      b.textContent = text;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', onClick);
      el.appendChild(b);
      return b;
    };

    const labels = editor.labels;
    this.typeButton = button('', labels.turnInto, 'mbe-tool-type', () => this.toggleTypeMenu());
    this.typeButton.setAttribute('aria-haspopup', 'menu');
    el.appendChild(separator(doc));
    for (const b of MARK_BUTTONS) {
      const btn = button(b.text, `${labels[b.label]} (${b.shortcut})`, `mbe-tool-${b.mark}`, () => {
        editor.toggleMark(b.mark);
        this.update();
      });
      btn.setAttribute('aria-pressed', 'false');
      this.markButtons.set(b.mark, btn);
    }
    el.appendChild(separator(doc));
    this.linkButton = button(labels.link, `${labels.link} (${mod('K')})`, 'mbe-tool-link', () => editor.openLinkPopover());

    this.typeMenu = new Menu(editor.root, 'mbe-type-menu', 'menu');
    this.typeMenu.onPicked = () => {
      this.typeMenu.hide();
      this.update();
    };
  }

  get isOpen(): boolean {
    return this.popup.isOpen;
  }

  show(): void {
    const rect = this.editor.selectionRect();
    if (!rect) return this.hide();
    this.update();
    // On touch devices the system text menu sits above the selection.
    this.popup.show(rect, isTouch() ? 'below' : 'above', 8);
    if (this.typeMenu.isOpen) this.typeMenu.popup.show(this.typeButton.getBoundingClientRect(), 'below');
  }

  hide(): void {
    this.popup.hide();
    this.typeMenu.hide();
  }

  destroy(): void {
    this.popup.destroy();
    this.typeMenu.destroy();
  }

  private update(): void {
    this.typeButton.textContent = `${this.editor.currentTypeLabel()} ▾`;
    for (const [mark, btn] of this.markButtons) {
      const on = this.editor.isMarkActive(mark);
      btn.classList.toggle('mbe-active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    this.linkButton.classList.toggle('mbe-active', this.editor.activeLinkHref() !== null);
  }

  private toggleTypeMenu(): void {
    if (this.typeMenu.isOpen) return this.typeMenu.hide();
    this.typeMenu.setSections([{ items: this.editor.turnIntoItems() }]);
    this.typeMenu.popup.show(this.typeButton.getBoundingClientRect(), 'below');
  }
}

function separator(doc: Document): HTMLElement {
  const s = doc.createElement('span');
  s.className = 'mbe-tool-sep';
  return s;
}

/** A small input for a link URL. Enter applies, Escape cancels, an empty value removes the link. */
export class LinkPopover {
  private readonly popup: Popup;
  private readonly input: HTMLInputElement;
  private readonly removeButton: HTMLButtonElement;
  private done: ((href: string | null) => void) | null = null;

  constructor(editor: Editor) {
    const doc = editor.root.ownerDocument;
    this.popup = new Popup(editor.root, 'mbe-link-popover');
    this.input = doc.createElement('input');
    this.input.type = 'url';
    this.input.className = 'mbe-link-input';
    this.input.placeholder = editor.labels.linkPlaceholder;
    this.input.setAttribute('aria-label', editor.labels.link);
    this.removeButton = doc.createElement('button');
    this.removeButton.type = 'button';
    this.removeButton.className = 'mbe-tool';
    this.removeButton.textContent = editor.labels.removeLink;
    this.popup.el.append(this.input, this.removeButton);

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.finish(this.input.value.trim());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.finish(null);
      }
    });
    this.input.addEventListener('blur', () => {
      // Clicking "Remove link" blurs the input first; let its click run.
      setTimeout(() => {
        if (this.popup.isOpen && doc.activeElement !== this.input) this.close();
      }, 150);
    });
    this.removeButton.addEventListener('click', () => this.finish(''));
  }

  get isOpen(): boolean {
    return this.popup.isOpen;
  }

  contains(node: Node): boolean {
    return this.popup.el.contains(node);
  }

  open(rect: DOMRect, value: string, done: (href: string | null) => void): void {
    this.done = done;
    this.input.value = value;
    this.removeButton.hidden = value === '';
    this.popup.show(rect, 'below');
    this.input.focus();
    this.input.select();
  }

  /** Closes without changing anything and without refocusing the editor. */
  private close(): void {
    this.done = null;
    this.popup.hide();
  }

  private finish(href: string | null): void {
    const done = this.done;
    this.done = null;
    this.popup.hide();
    done?.(href);
  }

  destroy(): void {
    this.popup.destroy();
  }
}
