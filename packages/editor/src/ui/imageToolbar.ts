// The image toolbar: a small toolbar over the selected image with its actions,
// so they are found without opening the block menu: Align (image blocks only),
// Alt text, Reset size (resized images only) and Delete. It shows for every
// image, inline and in a quote or list item too, where there is no block menu.

import type { Editor } from '../editor';
import { type IconName, iconNode } from '../icons';
import type { Labels } from '../labels';
import type { ImageAlign } from '../model';
import { Popup, isTouch } from './popup';
import { type ImageTarget, visibleRect } from './resizeHandles';

const ALIGNS: readonly { align: ImageAlign; icon: IconName & keyof Labels }[] = [
  { align: 'left', icon: 'imageAlignLeft' },
  { align: 'center', icon: 'imageAlignCenter' },
  { align: 'right', icon: 'imageAlignRight' },
];

export class ImageToolbar {
  private readonly popup: Popup;
  private readonly alignButtons: { align: ImageAlign; button: HTMLButtonElement }[] = [];
  private readonly alignSep: HTMLElement;
  private readonly resetButton: HTMLButtonElement;
  private target: ImageTarget | null = null;

  constructor(
    private readonly editor: Editor,
    actions: {
      align: (target: ImageTarget, align: ImageAlign) => void;
      altText: (target: ImageTarget) => void;
      resetSize: (target: ImageTarget) => void;
      remove: (target: ImageTarget) => void;
    },
  ) {
    const doc = editor.root.ownerDocument;
    const labels = editor.labels;
    this.popup = new Popup(editor.root, 'mbe-image-toolbar');
    const el = this.popup.el;
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', labels.imageSection);

    const button = (name: IconName & keyof Labels, className: string, onClick: () => void) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `mbe-tool ${className}`;
      const icon = iconNode(doc, editor.icon(name));
      if (icon) b.appendChild(icon);
      b.setAttribute('aria-label', labels[name]);
      b.title = labels[name];
      b.addEventListener('click', () => {
        if (this.target) onClick();
      });
      return b;
    };
    for (const { align, icon } of ALIGNS) {
      const b = button(icon, `mbe-tool-${icon}`, () => actions.align(this.target!, align));
      b.setAttribute('aria-pressed', 'false');
      this.alignButtons.push({ align, button: b });
      el.appendChild(b);
    }
    this.alignSep = doc.createElement('span');
    this.alignSep.className = 'mbe-tool-sep';
    el.appendChild(this.alignSep);
    el.appendChild(button('altText', 'mbe-tool-altText', () => actions.altText(this.target!)));
    this.resetButton = button('resetImageSize', 'mbe-tool-resetImageSize', () => actions.resetSize(this.target!));
    el.appendChild(this.resetButton);
    const sep = doc.createElement('span');
    sep.className = 'mbe-tool-sep';
    el.appendChild(sep);
    el.appendChild(button('delete', 'mbe-tool-delete', () => actions.remove(this.target!)));
  }

  get isOpen(): boolean {
    return this.popup.isOpen;
  }

  /** True if `node` is in the toolbar. */
  contains(node: Node): boolean {
    return this.popup.el.contains(node);
  }

  /**
   * Shows the toolbar over `target`, the selected image, with the alignment
   * buttons only for an image block (`block`). Over the part of the image its
   * scrolling container shows, so it stays by the image in a short composer.
   */
  show(target: ImageTarget, block: boolean): void {
    const shown = visibleRect(target.el, target.el.getBoundingClientRect());
    if (!shown) return this.hide();
    this.target = target;
    const align = target.image.align ?? 'left';
    for (const { align: value, button } of this.alignButtons) {
      button.hidden = !block;
      button.classList.toggle('mbe-active', block && value === align);
      button.setAttribute('aria-pressed', String(block && value === align));
    }
    this.alignSep.hidden = !block;
    this.resetButton.hidden = !target.image.width;
    const { left, top, width, height } = shown;
    // On touch devices the system menu may sit above the selection.
    this.popup.show({ left, top, right: left + width, bottom: top + height }, isTouch() ? 'below' : 'above', 8);
  }

  hide(): void {
    this.target = null;
    this.popup.hide();
  }

  destroy(): void {
    this.popup.destroy();
  }
}
