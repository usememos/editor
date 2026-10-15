// The floating formatting toolbar shown over selected text, and the link input.

import type { Editor } from '../editor';
import { type BlockTypeSpec, convertibleBlocks, setBlockType, toggleBlockType, toggleMark } from '../commands';
import { type IconName, iconNode } from '../icons';
import { type HeadingLevel, type ListType, type Mark, quoteKind } from '../model';
import { Menu, type MenuItem, Popup, isMac, isTouch, visibleViewport } from './popup';

/** A control of the formatting toolbar (the `toolbar` option's `items`). */
export type ToolbarItem = 'textStyle' | 'bold' | 'italic' | 'strike' | 'inlineCode' | 'link' | 'quote' | 'codeBlock' | 'list';

/** The controls in the order they appear, in groups with a divider between them. */
const GROUPS: readonly (readonly ToolbarItem[])[] = [
  ['textStyle'],
  ['bold', 'italic', 'strike', 'inlineCode', 'link'],
  ['quote', 'codeBlock', 'list'],
];

/** Every control, in order: the default `items`. */
export const TOOLBAR_ITEMS: readonly ToolbarItem[] = GROUPS.flat();

/** Controls that change block types, hidden in a table cell. */
const BLOCK_ITEMS: readonly ToolbarItem[] = ['textStyle', 'quote', 'codeBlock', 'list'];

/** `aria-keyshortcuts` for a key with the platform's command modifier. */
const mod = (keys: string) => `${isMac ? 'Meta' : 'Control'}+${keys}`;

const MARKS: Partial<Record<ToolbarItem, { mark: Mark; className: string; keys: string }>> = {
  bold: { mark: 'bold', className: 'mbe-tool-bold', keys: mod('B') },
  italic: { mark: 'italic', className: 'mbe-tool-italic', keys: mod('I') },
  strike: { mark: 'strike', className: 'mbe-tool-strike', keys: mod('Shift+X') },
  inlineCode: { mark: 'code', className: 'mbe-tool-code', keys: mod('E') },
};

/** A text style: paragraph or a heading level. */
type TextStyle = 'text' | 'heading1' | 'heading2' | 'heading3' | 'heading4';

const TEXT_STYLES: readonly { id: TextStyle; spec: BlockTypeSpec; keys: string }[] = [
  { id: 'text', spec: { type: 'paragraph' }, keys: mod('Alt+0') },
  { id: 'heading1', spec: { type: 'heading', level: 1 }, keys: mod('Alt+1') },
  { id: 'heading2', spec: { type: 'heading', level: 2 }, keys: mod('Alt+2') },
  { id: 'heading3', spec: { type: 'heading', level: 3 }, keys: mod('Alt+3') },
  { id: 'heading4', spec: { type: 'heading', level: 4 }, keys: mod('Alt+4') },
];

const LIST_TYPES: readonly { id: 'bulletList' | 'numberedList' | 'todoList'; listType: ListType; keys: string }[] = [
  { id: 'bulletList', listType: 'bullet', keys: mod('Shift+8') },
  { id: 'numberedList', listType: 'ordered', keys: mod('Shift+7') },
  { id: 'todoList', listType: 'task', keys: mod('Shift+9') },
];

/** How long the pointer rests on a button before its tooltip shows. */
const TOOLTIP_DELAY = 500;
/** After a tooltip hides, the next one within this time shows at once, as when moving along the buttons. */
const TOOLTIP_GRACE = 300;

/** What the selected blocks have in common, for the toolbar's states. */
interface BlockState {
  /** The style every selected block has, or null when they differ or one is not a paragraph or heading 1–4. */
  style: TextStyle | null;
  /** True when every selected block is a heading. */
  allHeadings: boolean;
  /** The list type every selected block has, or null. */
  listType: ListType | null;
  /** True when every selected block is a list item. */
  allListItems: boolean;
  allQuotes: boolean;
}

function blockState(editor: Editor): BlockState {
  const blocks = convertibleBlocks(editor.state);
  const styleOf = (b: (typeof blocks)[number]): TextStyle | null =>
    b.type === 'paragraph' ? 'text' : b.type === 'heading' && b.level <= 4 ? (`heading${b.level}` as TextStyle) : null;
  const every = <T>(f: (b: (typeof blocks)[number]) => T): T | null => {
    const first = blocks[0] ? f(blocks[0]) : null;
    return blocks.every((b) => f(b) === first) ? first : null;
  };
  const some = blocks.length > 0;
  return {
    style: every(styleOf),
    allHeadings: some && blocks.every((b) => b.type === 'heading'),
    listType: every((b) => (b.type === 'listItem' ? b.listType : null)),
    allListItems: some && blocks.every((b) => b.type === 'listItem'),
    allQuotes: some && blocks.every((b) => quoteKind(b) !== null),
  };
}

/** A button that opens a menu: its icon shows the current choice. */
interface MenuTrigger {
  button: HTMLButtonElement;
  icon: HTMLElement;
  menu: Menu;
  iconName: IconName | null;
}

export class FormatToolbar {
  private readonly popup: Popup;
  private readonly tooltip: Popup;
  private readonly buttons = new Map<ToolbarItem, HTMLButtonElement>();
  private readonly separators: HTMLElement[] = [];
  private textStyle: MenuTrigger | null = null;
  private list: MenuTrigger | null = null;
  private openTrigger: MenuTrigger | null = null;
  private tooltipTimer: ReturnType<typeof setTimeout> | undefined;
  private tooltipHiddenAt = 0;
  /** Called when a menu opens, closes or moves its highlight, so the editor can update `aria-activedescendant`. */
  onMenuChange: (() => void) | null = null;

  constructor(
    private readonly editor: Editor,
    items: readonly ToolbarItem[] = TOOLBAR_ITEMS,
  ) {
    const doc = editor.root.ownerDocument;
    this.popup = new Popup(editor.root, 'mbe-toolbar');
    const el = this.popup.el;
    el.setAttribute('role', 'toolbar');
    this.tooltip = new Popup(editor.root, 'mbe-tooltip');
    this.tooltip.el.setAttribute('aria-hidden', 'true');

    const labels = editor.labels;
    const button = (item: ToolbarItem, icon: IconName, className: string, keys: string | null, onClick: () => void) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `mbe-tool ${className}`;
      const content = iconNode(doc, editor.icon(icon));
      if (content) b.appendChild(content);
      b.setAttribute('aria-label', labels[item === 'codeBlock' ? 'code' : item]);
      if (keys) b.setAttribute('aria-keyshortcuts', keys);
      b.addEventListener('click', onClick);
      b.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') this.scheduleTooltip(b);
      });
      b.addEventListener('pointerleave', () => this.hideTooltip());
      this.buttons.set(item, b);
      return b;
    };
    const trigger = (item: 'textStyle' | 'list', className: string, menuClass: string): MenuTrigger => {
      const b = button(item, item === 'list' ? 'bulletList' : 'text', className, null, () => this.toggleMenu(t));
      b.classList.add('mbe-tool-menu');
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      // The first child is the icon of the current choice; the chevron follows it.
      const icon = doc.createElement('span');
      icon.className = 'mbe-tool-icon';
      icon.append(...b.childNodes);
      const chevron = doc.createElement('span');
      chevron.className = 'mbe-tool-chevron';
      const content = iconNode(doc, editor.icon('chevronDown'));
      if (content) chevron.appendChild(content);
      b.append(icon, chevron);
      const menu = new Menu(editor.root, menuClass, 'menu');
      menu.el.setAttribute('aria-label', labels[item]);
      menu.checkIcon = editor.icon('selected');
      menu.onPicked = () => this.closeMenu();
      menu.onHighlight = () => this.onMenuChange?.();
      b.setAttribute('aria-controls', menu.el.id);
      const t: MenuTrigger = { button: b, icon, menu, iconName: item === 'list' ? 'bulletList' : 'text' };
      return t;
    };

    const shown = new Set(items);
    for (const group of GROUPS) {
      const present = group.filter((item) => shown.has(item));
      if (present.length === 0) continue;
      if (this.buttons.size > 0) {
        const sep = doc.createElement('span');
        sep.className = 'mbe-tool-sep';
        el.appendChild(sep);
        this.separators.push(sep);
      }
      for (const item of present) {
        const mark = MARKS[item];
        let b: HTMLButtonElement;
        if (mark) {
          b = button(item, item as IconName, mark.className, mark.keys, () => this.apply((s) => toggleMark(s, mark.mark)));
          b.setAttribute('aria-pressed', 'false');
        } else if (item === 'link') {
          b = button(item, 'link', 'mbe-tool-link', mod('K'), () => editor.openLinkPopover());
          b.setAttribute('aria-pressed', 'false');
        } else if (item === 'quote') {
          b = button(item, 'quote', 'mbe-tool-quote', null, () => this.apply((s) => toggleBlockType(s, { type: 'quote' })));
          b.setAttribute('aria-pressed', 'false');
        } else if (item === 'codeBlock') {
          b = button(item, 'code', 'mbe-tool-code-block', mod('Alt+C'), () => this.apply((s) => toggleBlockType(s, { type: 'code' })));
        } else if (item === 'textStyle') {
          this.textStyle = trigger(item, 'mbe-tool-text-style', 'mbe-text-style-menu');
          b = this.textStyle.button;
        } else {
          this.list = trigger('list', 'mbe-tool-list', 'mbe-list-menu');
          b = this.list.button;
        }
        el.appendChild(b);
      }
    }
  }

  get isOpen(): boolean {
    return this.popup.isOpen;
  }

  /** The open menu of the text style or list button, if any. */
  get menu(): Menu | null {
    return this.openTrigger?.menu ?? null;
  }

  /** True if `node` is in the toolbar or one of its menus. */
  contains(node: Node): boolean {
    return this.popup.el.contains(node) || !!this.openTrigger?.menu.el.contains(node);
  }

  show(): void {
    const rect = this.editor.selectionRect();
    if (!rect) return this.hide();
    this.update();
    // Wider than the screen (a phone), it scrolls sideways rather than wrap.
    const view = this.editor.root.ownerDocument.defaultView!;
    this.popup.el.style.maxWidth = `${Math.max(visibleViewport(view).width - 16, 0)}px`;
    // On touch devices the system text menu sits above the selection.
    this.popup.show(rect, isTouch() ? 'below' : 'above', 8);
    if (this.openTrigger) this.placeMenu(this.openTrigger);
  }

  hide(): void {
    this.closeMenu();
    this.hideTooltip();
    this.popup.hide();
  }

  /** Closes the open menu and leaves the toolbar open. */
  closeMenu(): void {
    const t = this.openTrigger;
    if (!t) return;
    this.openTrigger = null;
    t.menu.hide();
    t.button.classList.remove('mbe-open');
    t.button.setAttribute('aria-expanded', 'false');
    this.onMenuChange?.();
  }

  destroy(): void {
    clearTimeout(this.tooltipTimer);
    this.popup.destroy();
    this.tooltip.destroy();
    this.textStyle?.menu.destroy();
    this.list?.menu.destroy();
  }

  /** Applies a command to the selection and updates the buttons' states. */
  private apply(command: Parameters<Editor['run']>[0]): void {
    this.hideTooltip();
    this.editor.run(command);
    if (this.isOpen) this.update();
  }

  private update(): void {
    const editor = this.editor;
    for (const [item, btn] of this.buttons) {
      const mark = MARKS[item];
      if (mark) setPressed(btn, editor.isActive(mark.mark as 'bold'));
    }
    const link = this.buttons.get('link');
    if (link) setPressed(link, editor.isActive('link'));

    // A table cell cannot change type, so the block controls hide there.
    const { anchor, focus } = editor.state.selection;
    const inCell = !!focus.cell && anchor.blockId === focus.blockId;
    for (const item of BLOCK_ITEMS) this.buttons.get(item)?.toggleAttribute('hidden', inCell);
    if (inCell) this.closeMenu();
    // A divider shows only between two groups that have a visible button.
    for (const sep of this.separators) {
      const visible = (start: Element | null, step: 'previousElementSibling' | 'nextElementSibling') => {
        for (let e = start; e && !e.classList.contains('mbe-tool-sep'); e = e[step]) if (!(e as HTMLElement).hidden) return true;
        return false;
      };
      sep.hidden = !visible(sep.previousElementSibling, 'previousElementSibling') || !visible(sep.nextElementSibling, 'nextElementSibling');
    }
    if (inCell) return;

    const state = blockState(editor);
    const quote = this.buttons.get('quote');
    if (quote) setPressed(quote, state.allQuotes);
    if (this.textStyle) {
      this.setTriggerIcon(this.textStyle, state.style ?? 'text');
      this.textStyle.button.classList.toggle('mbe-active', state.allHeadings);
    }
    if (this.list) {
      const current = LIST_TYPES.find((l) => l.listType === state.listType);
      this.setTriggerIcon(this.list, current?.id ?? 'bulletList');
      this.list.button.classList.toggle('mbe-active', state.allListItems);
    }
  }

  private setTriggerIcon(t: MenuTrigger, name: IconName): void {
    if (t.iconName === name) return;
    t.iconName = name;
    const content = iconNode(t.icon.ownerDocument, this.editor.icon(name));
    t.icon.replaceChildren(...(content ? [content] : []));
  }

  private toggleMenu(t: MenuTrigger): void {
    const wasOpen = this.openTrigger === t;
    this.closeMenu();
    this.hideTooltip();
    if (wasOpen) return;
    const state = blockState(this.editor);
    const labels = this.editor.labels;
    let items: MenuItem[];
    let current: string | undefined;
    if (t === this.textStyle) {
      current = state.style ?? undefined;
      items = TEXT_STYLES.map(({ id, spec, keys }) => ({
        id,
        label: labels[id],
        icon: this.editor.icon(id),
        labelClass: `mbe-menu-${id}`,
        keyShortcuts: keys,
        checked: id === current,
        // Sets the style; picking the current one changes nothing.
        run: () => id !== current && this.apply((s) => setBlockType(s, spec)),
      }));
    } else {
      current = LIST_TYPES.find((l) => l.listType === state.listType)?.id;
      items = LIST_TYPES.map(({ id, listType, keys }) => ({
        id,
        label: labels[id],
        icon: this.editor.icon(id),
        keyShortcuts: keys,
        checked: id === current,
        run: () => this.apply((s) => toggleBlockType(s, { type: 'listItem', listType })),
      }));
    }
    t.menu.setSections([{ items }]);
    if (current) t.menu.highlightId(current);
    this.openTrigger = t;
    t.button.classList.add('mbe-open');
    t.button.setAttribute('aria-expanded', 'true');
    this.placeMenu(t);
    this.onMenuChange?.();
  }

  /** Puts the menu next to its button, on the side of the toolbar away from the selection. */
  private placeMenu(t: MenuTrigger): void {
    const rtl = this.editor.root.ownerDocument.defaultView!.getComputedStyle(this.editor.root).direction === 'rtl';
    t.menu.popup.show(t.button.getBoundingClientRect(), this.popup.side, 4, rtl ? 'end' : 'start');
  }

  private scheduleTooltip(button: HTMLButtonElement): void {
    clearTimeout(this.tooltipTimer);
    if (this.openTrigger) return;
    const delay = Date.now() - this.tooltipHiddenAt < TOOLTIP_GRACE ? 0 : TOOLTIP_DELAY;
    this.tooltipTimer = setTimeout(() => {
      if (!this.isOpen || this.openTrigger || !button.isConnected) return;
      this.tooltip.el.textContent = button.getAttribute('aria-label');
      this.tooltip.show(button.getBoundingClientRect(), this.popup.side, 6);
      // Centered over the button, as far as the screen allows.
      const b = button.getBoundingClientRect();
      const t = this.tooltip.el.getBoundingClientRect();
      const view = this.editor.root.ownerDocument.defaultView!;
      const left = Math.max(8, Math.min(b.left + (b.width - t.width) / 2, view.innerWidth - t.width - 8));
      this.tooltip.el.style.left = `${parseFloat(this.tooltip.el.style.left) + left - t.left}px`;
    }, delay);
  }

  private hideTooltip(): void {
    clearTimeout(this.tooltipTimer);
    if (!this.tooltip.isOpen) return;
    this.tooltip.hide();
    this.tooltipHiddenAt = Date.now();
  }
}

function setPressed(button: HTMLButtonElement, on: boolean): void {
  button.classList.toggle('mbe-active', on);
  button.setAttribute('aria-pressed', String(on));
}

/** What an InputPopover edits: a link URL or an image's alt text. */
export interface InputPopoverOptions {
  readonly value: string;
  /** The input's accessible name. */
  readonly label: string;
  readonly placeholder: string;
  readonly type: 'url' | 'text';
  /** Text of a button that applies an empty value, shown when the value is not empty. Without it there is no button. */
  readonly removeLabel?: string;
}

/**
 * A small input over the editor: the link popover (Mod+K) and an image's
 * alt text. Enter applies the trimmed value, Escape cancels, and the remove
 * button applies an empty value.
 */
export class InputPopover {
  private readonly popup: Popup;
  private readonly input: HTMLInputElement;
  private readonly removeButton: HTMLButtonElement;
  private done: ((value: string | null) => void) | null = null;

  constructor(editor: Editor) {
    const doc = editor.root.ownerDocument;
    this.popup = new Popup(editor.root, 'mbe-input-popover');
    this.input = doc.createElement('input');
    this.input.className = 'mbe-popover-input';
    this.removeButton = doc.createElement('button');
    this.removeButton.type = 'button';
    this.removeButton.className = 'mbe-tool';
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
      // Clicking the remove button blurs the input first; let its click run.
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

  open(rect: DOMRect, options: InputPopoverOptions, done: (value: string | null) => void): void {
    this.done = done;
    this.input.type = options.type;
    this.input.value = options.value;
    this.input.placeholder = options.placeholder;
    this.input.setAttribute('aria-label', options.label);
    this.removeButton.textContent = options.removeLabel ?? '';
    this.removeButton.hidden = !options.removeLabel || options.value === '';
    this.popup.show(rect, 'below');
    this.input.focus();
    this.input.select();
  }

  /** Closes without changing anything and without refocusing the editor. */
  private close(): void {
    this.done = null;
    this.popup.hide();
  }

  private finish(value: string | null): void {
    const done = this.done;
    this.done = null;
    this.popup.hide();
    done?.(value);
  }

  destroy(): void {
    this.popup.destroy();
  }
}
