// The link card: a small toolbar under a link while editing, with its URL and
// buttons to open, copy, edit and remove it. It shows when the pointer rests on
// a link, and when the caret is inside one, as Linear's link toolbar does.

import type { Editor } from '../editor';
import { type IconName, iconNode } from '../icons';
import type { Labels } from '../labels';
import { Popup } from './popup';

/** A link in the document and its element. */
export interface LinkTarget {
  readonly el: HTMLAnchorElement;
  /** The URL as written in the Markdown. */
  readonly href: string;
}

/** How long the pointer rests on a link before the card shows. */
const HOVER_DELAY = 300;
/** How long the card stays after the pointer leaves the link or the card, so it can move between them. */
const LEAVE_DELAY = 250;

export class LinkCard {
  private readonly popup: Popup;
  private readonly url: HTMLAnchorElement;
  private readonly copyButton: HTMLButtonElement;
  private target: LinkTarget | null = null;
  /** What shows the card: the pointer on a link, or the caret in one. The pointer wins. */
  private hovered: LinkTarget | null = null;
  private caret: LinkTarget | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly editor: Editor,
    private readonly actions: {
      open: (target: LinkTarget, event: MouseEvent) => void;
      edit: (target: LinkTarget) => void;
      remove: (target: LinkTarget) => void;
      /** The link of `el`, or null when it is not a link of the document. */
      targetOf: (el: HTMLAnchorElement) => LinkTarget | null;
    },
  ) {
    const doc = editor.root.ownerDocument;
    const labels = editor.labels;
    this.popup = new Popup(editor.root, 'mbe-link-card');
    const el = this.popup.el;
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', labels.link);

    this.url = doc.createElement('a');
    this.url.className = 'mbe-link-card-url';
    this.url.target = '_blank';
    this.url.rel = 'noopener noreferrer';
    this.url.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.target) actions.open(this.target, e);
    });
    const button = (name: IconName & keyof Labels, onClick: (e: MouseEvent) => void) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `mbe-tool mbe-link-card-${name}`;
      setIcon(b, editor, name);
      b.setAttribute('aria-label', labels[name]);
      b.title = labels[name];
      b.addEventListener('click', (e) => {
        if (this.target) onClick(e);
      });
      return b;
    };
    const open = button('openLink', (e) => actions.open(this.target!, e));
    this.copyButton = button('copyLink', () => this.copy());
    const edit = button('editLink', () => {
      const target = this.target!;
      this.hide();
      actions.edit(target);
    });
    const remove = button('removeLink', () => {
      const target = this.target!;
      this.hide();
      actions.remove(target);
    });
    const sep = doc.createElement('span');
    sep.className = 'mbe-tool-sep';
    el.append(this.url, sep, open, this.copyButton, edit, remove);

    const root = editor.root;
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      target.addEventListener(type, fn);
      this.cleanup.push(() => target.removeEventListener(type, fn));
    };
    on(root, 'mouseover', (e) => this.onOver(e));
    on(root, 'mouseout', (e) => this.onOut(e));
    on(el, 'mouseenter', () => this.cancelHide());
    on(el, 'mouseleave', () => {
      if (this.hovered) this.scheduleHide();
    });
  }

  get isOpen(): boolean {
    return this.popup.isOpen;
  }

  contains(node: Node): boolean {
    return this.popup.el.contains(node);
  }

  /** Sets the link with the caret (null for none) and shows or hides the card to match. */
  setCaret(target: LinkTarget | null): void {
    this.caret = target;
    if (this.hovered && !this.hovered.el.isConnected) this.hovered = null;
    this.render();
  }

  /** Places the card under its link again, after scrolling or a layout change. */
  reposition(): void {
    if (!this.target) return;
    if (!this.target.el.isConnected) return this.hide();
    this.place(this.target);
  }

  hide(): void {
    this.clearTimers();
    this.hovered = null;
    this.caret = null;
    this.target = null;
    this.popup.hide();
  }

  destroy(): void {
    this.clearTimers();
    if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
    for (const fn of this.cleanup) fn();
    this.popup.destroy();
  }

  private onOver(e: MouseEvent): void {
    if (!this.editor.isEditable || e.buttons !== 0) return;
    const el = (e.target as Element | null)?.closest?.<HTMLAnchorElement>('a.mbe-link');
    if (!el || !this.editor.root.contains(el)) return;
    this.cancelHide();
    if (this.hovered?.el === el) return;
    if (this.showTimer !== null) clearTimeout(this.showTimer);
    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      const target = this.actions.targetOf(el);
      if (!target || !this.editor.isEditable) return;
      this.hovered = target;
      this.render();
    }, this.popup.isOpen ? 0 : HOVER_DELAY);
  }

  private onOut(e: MouseEvent): void {
    const el = (e.target as Element | null)?.closest?.('a.mbe-link');
    if (!el) return;
    const next = e.relatedTarget as Node | null;
    if (next && (el.contains(next) || this.popup.el.contains(next))) return;
    if (this.showTimer !== null) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    if (this.hovered) this.scheduleHide();
  }

  private render(): void {
    const target = this.hovered ?? this.caret;
    if (!target) {
      this.target = null;
      this.popup.hide();
      return;
    }
    if (this.target?.el !== target.el || this.target.href !== target.href) {
      this.target = target;
      this.url.textContent = target.href;
      this.url.title = target.href;
      // The resolved URL; a link the policy dropped has none and cannot be opened.
      const resolved = target.el.getAttribute('href');
      if (resolved) this.url.href = resolved;
      else this.url.removeAttribute('href');
      const open = this.popup.el.querySelector<HTMLButtonElement>('.mbe-link-card-openLink');
      if (open) open.disabled = !resolved;
      this.showCopied(false);
    }
    this.place(target);
  }

  private place(target: LinkTarget): void {
    // The last line of a link that wraps, so the card sits right under where it ends.
    const rects = target.el.getClientRects();
    const rect = rects.length > 0 ? rects[rects.length - 1]! : target.el.getBoundingClientRect();
    this.popup.show(rect, 'below', 4);
  }

  private copy(): void {
    const href = this.target!.href;
    const done = () => this.showCopied(true);
    const clipboard = this.editor.root.ownerDocument.defaultView?.navigator.clipboard;
    if (clipboard) clipboard.writeText(href).then(done, () => {});
  }

  private showCopied(copied: boolean): void {
    if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
    this.copiedTimer = null;
    const b = this.copyButton;
    const name = copied ? 'copied' : 'copyLink';
    setIcon(b, this.editor, name);
    b.setAttribute('aria-label', this.editor.labels[name]);
    b.title = this.editor.labels[name];
    if (copied) this.copiedTimer = setTimeout(() => this.showCopied(false), 1500);
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hovered = null;
      this.render();
    }, LEAVE_DELAY);
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private clearTimers(): void {
    this.cancelHide();
    if (this.showTimer !== null) clearTimeout(this.showTimer);
    this.showTimer = null;
  }
}

function setIcon(button: HTMLButtonElement, editor: Editor, name: IconName): void {
  const icon = iconNode(button.ownerDocument, editor.icon(name));
  button.replaceChildren(...(icon ? [icon] : []));
}
