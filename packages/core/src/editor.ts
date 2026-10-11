// The editor view: one contentEditable root that the editor fully owns.
//
// Input strategy ("model first, DOM fallback"):
// 1. Most edits arrive as `beforeinput` events. We cancel them, apply the
//    matching command to the model, and re-render the changed blocks.
// 2. IME composition cannot be cancelled. During composition the browser
//    edits the DOM itself and we do not touch it. On `compositionend` we read
//    the changed text back from the DOM and apply it to the model.
// 3. Any other `input` that slipped through (e.g. some Android keyboards) is
//    reconciled the same way as composition.

import * as cmd from './commands';
import { docToHtml } from './clipboard/toHtml';
import { htmlToDoc } from './clipboard/fromHtml';
import { type ChangeKind, History } from './history';
import { DEFAULT_LABELS, type Labels } from './labels';
import { parseMarkdown } from './markdown/parse';
import { serializeMarkdown } from './markdown/serialize';
import {
  type Block,
  type Doc,
  type EditorState,
  type Mark,
  type Position,
  type Selection,
  clampSelection,
  containerContent,
  createState,
  endOf,
  getBlock,
  inlineText,
  isCollapsed,
  isPlainTextBlock,
  isTextBlock,
  paragraph,
  plain,
  samePosition,
  startOf,
} from './model';
import { FormatToolbar, LinkPopover } from './ui/toolbar';
import { BlockHandle } from './ui/handle';
import { Menu, type MenuItem, type MenuSection, isMac, isTouch, matches } from './ui/popup';
import { BlockRenderer, contentElement, domText, domToPosition, positionToDom, safeHref } from './view/dom';

export interface EditorOptions {
  /** Initial Markdown. */
  value?: string;
  /** Called with the new Markdown after document changes, at most once per animation frame. */
  onChange?: (markdown: string, editor: Editor) => void;
  /** Shown when the document is empty. */
  placeholder?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  /** Shows the formatting toolbar on selection. Default true. */
  toolbar?: boolean;
  /** Called on Mod+Enter with the current Markdown. */
  onSubmit?: (markdown: string, editor: Editor) => void;
  onFocus?: (editor: Editor) => void;
  onBlur?: (editor: Editor) => void;
  /** IDs of built-in slash menu items to show, in order. See SLASH_ITEM_IDS. */
  slashItems?: readonly SlashItemId[];
  /** Overrides UI strings. */
  labels?: Partial<Labels>;
}

export const SLASH_ITEM_IDS = [
  'text',
  'heading1',
  'heading2',
  'heading3',
  'bulletList',
  'numberedList',
  'todoList',
  'quote',
  'code',
  'table',
  'divider',
] as const;
export type SlashItemId = (typeof SLASH_ITEM_IDS)[number];

interface BlockItem {
  id: SlashItemId;
  icon: string;
  aliases: string[];
  spec: cmd.BlockTypeSpec;
}

/** Block types for the slash menu. Each label is `labels[id]`. */
const BLOCK_ITEMS: readonly BlockItem[] = [
  { id: 'text', icon: 'T', aliases: ['paragraph', 'plain'], spec: { type: 'paragraph' } },
  { id: 'heading1', icon: 'H1', aliases: ['h1', 'title'], spec: { type: 'heading', level: 1 } },
  { id: 'heading2', icon: 'H2', aliases: ['h2', 'subtitle'], spec: { type: 'heading', level: 2 } },
  { id: 'heading3', icon: 'H3', aliases: ['h3'], spec: { type: 'heading', level: 3 } },
  { id: 'bulletList', icon: '•', aliases: ['ul', 'unordered', 'bullet'], spec: { type: 'listItem', listType: 'bullet' } },
  { id: 'numberedList', icon: '1.', aliases: ['ol', 'ordered'], spec: { type: 'listItem', listType: 'ordered' } },
  { id: 'todoList', icon: '☐', aliases: ['task', 'checkbox', 'checklist'], spec: { type: 'listItem', listType: 'task' } },
  { id: 'quote', icon: '❝', aliases: ['blockquote', 'citation'], spec: { type: 'quote' } },
  { id: 'code', icon: '</>', aliases: ['pre', 'snippet', 'fence'], spec: { type: 'code' } },
  { id: 'table', icon: '⊞', aliases: ['grid'], spec: { type: 'table' } },
  { id: 'divider', icon: '—', aliases: ['hr', 'separator', 'line', 'rule'], spec: { type: 'divider' } },
];

/** Block menu actions for the table cell with the caret. Each label is `labels[id]`. */
const TABLE_ITEMS: readonly { id: keyof Labels; icon: string; action: cmd.TableAction }[] = [
  { id: 'addRowAbove', icon: '↑', action: { kind: 'addRowAbove' } },
  { id: 'addRowBelow', icon: '↓', action: { kind: 'addRowBelow' } },
  { id: 'addColumnLeft', icon: '←', action: { kind: 'addColumnLeft' } },
  { id: 'addColumnRight', icon: '→', action: { kind: 'addColumnRight' } },
  { id: 'alignLeft', icon: '⇤', action: { kind: 'align', align: 'left' } },
  { id: 'alignCenter', icon: '↔', action: { kind: 'align', align: 'center' } },
  { id: 'alignRight', icon: '⇥', action: { kind: 'align', align: 'right' } },
  { id: 'deleteRow', icon: '✕', action: { kind: 'deleteRow' } },
  { id: 'deleteColumn', icon: '✕', action: { kind: 'deleteColumn' } },
];

const SLASH_CHARS = ['/', '／'];

export class Editor {
  readonly root: HTMLElement;
  readonly labels: Labels;
  private state: EditorState;
  private readonly history = new History();
  private readonly renderer: BlockRenderer;
  private composing = false;
  private readOnly: boolean;
  private wasReadOnly = false;
  private readonly options: EditorOptions;
  private readonly cleanup: (() => void)[] = [];
  private changeFrame: number | null = null;
  private plainPasteNext = false;
  private destroyed = false;
  private focused = false;

  private readonly slashMenu: Menu;
  private slash: { blockId: string; from: number; query?: string } | null = null;
  private readonly blockMenu: Menu;
  private readonly toolbar: FormatToolbar | null;
  private readonly linkPopover: LinkPopover;
  private readonly handle: BlockHandle;
  private hintEl: HTMLElement | null = null;

  constructor(root: HTMLElement, options: EditorOptions = {}) {
    this.root = root;
    this.options = options;
    this.labels = { ...DEFAULT_LABELS, ...options.labels };
    this.readOnly = options.readOnly ?? false;
    this.state = createState(parseMarkdown(options.value ?? ''));
    this.renderer = new BlockRenderer(root, this.labels);

    root.classList.add('mbe-root');
    root.setAttribute('role', 'textbox');
    root.setAttribute('aria-multiline', 'true');
    root.spellcheck = true;
    root.translate = false;
    if (options.placeholder) root.style.setProperty('--mbe-placeholder', JSON.stringify(options.placeholder));
    root.style.setProperty('--mbe-slash-hint', JSON.stringify(this.labels.slashHint));

    this.slashMenu = new Menu(root, 'mbe-slash-menu', 'listbox');
    this.slashMenu.onPicked = () => this.closeSlash();
    this.blockMenu = new Menu(root, 'mbe-block-menu', 'menu');
    this.blockMenu.onPicked = () => this.blockMenu.hide();
    this.linkPopover = new LinkPopover(this);
    this.toolbar = options.toolbar === false ? null : new FormatToolbar(this);
    this.handle = new BlockHandle(this);

    this.listen(root, 'beforeinput', (e) => this.onBeforeInput(e as InputEvent));
    this.listen(root, 'input', (e) => this.onInput(e as InputEvent));
    this.listen(root, 'compositionstart', (e) => this.onCompositionStart(e));
    this.listen(root, 'compositionend', (e) => this.onCompositionEnd(e));
    this.listen(root, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(root, 'copy', (e) => this.onCopy(e as ClipboardEvent, false));
    this.listen(root, 'cut', (e) => this.onCopy(e as ClipboardEvent, true));
    this.listen(root, 'paste', (e) => this.onPaste(e as ClipboardEvent));
    this.listen(root, 'dragstart', (e) => e.preventDefault());
    this.listen(root, 'drop', (e) => e.preventDefault());
    this.listen(root, 'mousedown', (e) => this.onMouseDown(e as MouseEvent));
    this.listen(root, 'click', (e) => this.onClick(e as MouseEvent));
    this.listen(root, 'change', (e) => this.onControlChange(e));
    this.listen(root, 'focusin', () => this.onFocusIn());
    this.listen(root, 'focusout', (e) => this.onFocusOut(e as FocusEvent));
    this.listen(root.ownerDocument, 'selectionchange', () => this.onSelectionChange());
    this.listen(root.ownerDocument, 'scroll', () => this.onScroll(), true);

    this.renderer.render(this.state.doc, true, true);
    this.applyReadOnly();
    this.afterRender();
    if (options.autoFocus) this.focus();
  }

  // -------------------------------------------------------------------------
  // Public API

  getMarkdown(): string {
    return serializeMarkdown(this.state.doc);
  }

  /** Replaces the whole document. Clears undo history. */
  setMarkdown(markdown: string): void {
    this.history.clear();
    this.state = createState(parseMarkdown(markdown));
    this.renderer.render(this.state.doc, true, true);
    this.applyReadOnly();
    this.afterRender();
    this.syncDomSelection();
  }

  getState(): EditorState {
    return this.state;
  }

  getDoc(): Doc {
    return this.state.doc;
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    this.applyReadOnly();
    this.hideUi();
  }

  hasFocus(): boolean {
    const active = this.root.ownerDocument.activeElement;
    return !!active && this.root.contains(active) && !(active instanceof HTMLInputElement);
  }

  focus(): void {
    const pos = this.state.selection.focus;
    const el = this.renderer.elementFor(pos.blockId);
    const host = pos.cell && el ? contentElement(el, pos.cell) : this.root;
    (host ?? this.root).focus({ preventScroll: true });
    this.syncDomSelection(true);
  }

  blur(): void {
    (this.root.ownerDocument.activeElement as HTMLElement | null)?.blur();
  }

  /** Applies a command, records history, re-renders, and notifies onChange. */
  run(command: (state: EditorState) => EditorState | null, kind: ChangeKind = 'other'): boolean {
    if (this.readOnly) return false;
    const next = command(this.state);
    if (!next || next === this.state) return false;
    this.apply(next, kind);
    return true;
  }

  toggleMark(mark: Mark): boolean {
    return this.run((s) => cmd.toggleMark(s, mark));
  }

  undo(): boolean {
    const next = this.history.undo(this.state);
    if (!next) return false;
    this.commit(next);
    return true;
  }

  redo(): boolean {
    const next = this.history.redo(this.state);
    if (!next) return false;
    this.commit(next);
    return true;
  }

  /** Viewport rectangle of the selection, for positioning UI. */
  selectionRect(): DOMRect | null {
    const sel = this.root.ownerDocument.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects.length ? (isCollapsed(this.state.selection) ? rects[rects.length - 1]! : range.getBoundingClientRect()) : null;
    if (rect && (rect.width > 0 || rect.height > 0)) return rect;
    // An empty block has no text to measure.
    const el = this.renderer.elementFor(this.state.selection.focus.blockId);
    const content = el ? contentElement(el, this.state.selection.focus.cell) : null;
    return (content ?? el)?.getBoundingClientRect() ?? null;
  }

  /** The rendered element of a block. */
  blockElement(id: string): HTMLElement | undefined {
    return this.renderer.elementFor(id);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.changeFrame !== null) cancelAnimationFrame(this.changeFrame);
    for (const fn of this.cleanup) fn();
    this.slashMenu.destroy();
    this.blockMenu.destroy();
    this.toolbar?.destroy();
    this.linkPopover.destroy();
    this.handle.destroy();
    this.root.contentEditable = 'false';
    this.root.classList.remove('mbe-root');
    this.root.replaceChildren();
  }

  // -------------------------------------------------------------------------
  // State updates

  private apply(next: EditorState, kind: ChangeKind): void {
    if (next.doc !== this.state.doc) this.history.record(this.state, kind);
    this.commit(next);
  }

  private commit(next: EditorState): void {
    const docChanged = next.doc !== this.state.doc;
    // Re-rendering a table replaces the focused cell, so remember focus first.
    const hadFocus = this.hasFocus();
    this.state = next;
    this.renderer.render(next.doc);
    if (this.readOnly) this.applyReadOnly();
    this.syncDomSelection(hadFocus);
    this.afterRender();
    if (docChanged) this.scheduleChange();
  }

  /** Emits a pending onChange now, so a submit or blur handler sees the latest Markdown. */
  private flushChange(): void {
    if (this.changeFrame === null) return;
    cancelAnimationFrame(this.changeFrame);
    this.changeFrame = null;
    this.options.onChange?.(this.getMarkdown(), this);
  }

  private scheduleChange(): void {
    if (!this.options.onChange || this.changeFrame !== null) return;
    const flush = () => {
      this.changeFrame = null;
      if (!this.destroyed) this.options.onChange?.(this.getMarkdown(), this);
    };
    if (typeof requestAnimationFrame === 'function') this.changeFrame = requestAnimationFrame(flush);
    else flush();
  }

  /**
   * Applies read-only state to the root and to rendered cells and inputs.
   * New elements render editable, so this only does work when read-only is on
   * or has just changed.
   */
  private applyReadOnly(): void {
    const editable = this.readOnly ? 'false' : 'true';
    if (this.root.contentEditable !== editable) this.root.contentEditable = editable;
    if (!this.readOnly && !this.wasReadOnly) return;
    this.wasReadOnly = this.readOnly;
    this.root.classList.toggle('mbe-readonly', this.readOnly);
    this.root.setAttribute('aria-readonly', String(this.readOnly));
    this.root.querySelectorAll<HTMLElement>('[data-row]').forEach((cell) => {
      cell.contentEditable = this.readOnly ? 'false' : 'true';
    });
    this.root.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      input.disabled = this.readOnly;
    });
  }

  /** Hints for empty blocks, and the UI that follows the selection. */
  private afterRender(): void {
    for (const block of this.state.doc.blocks) {
      const el = this.renderer.elementFor(block.id);
      if (!el || !el.classList.contains('mbe-empty')) continue;
      let hint = '';
      if (block.type === 'heading') hint = this.labels[`heading${Math.min(block.level, 3)}` as 'heading1'];
      else if (block.type === 'listItem') hint = this.labels.listHint;
      else if (block.type === 'quote') hint = this.labels.quoteHint;
      if (hint && el.dataset.hint !== hint) el.dataset.hint = hint;
    }
    this.updateUi();
  }

  private syncDomSelection(force = false): void {
    const sel = this.root.ownerDocument.getSelection();
    if (!sel || (!force && !this.hasFocus())) return;
    const anchor = this.toDom(this.state.selection.anchor);
    const focus = this.toDom(this.state.selection.focus);
    if (!anchor || !focus) return;
    if (
      sel.anchorNode === anchor.node &&
      sel.anchorOffset === anchor.offset &&
      sel.focusNode === focus.node &&
      sel.focusOffset === focus.offset
    ) {
      return;
    }
    // A caret in a table cell needs that cell (its own editing host) focused.
    if (this.state.selection.focus.cell) {
      const host = (focus.node instanceof Element ? focus.node : focus.node.parentElement)?.closest<HTMLElement>('[data-row]');
      if (host && this.root.ownerDocument.activeElement !== host) host.focus({ preventScroll: true });
    } else if (this.root.ownerDocument.activeElement !== this.root && this.hasFocus()) {
      this.root.focus({ preventScroll: true });
    }
    sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  }

  private toDom(pos: Position): { node: Node; offset: number } | null {
    const el = this.renderer.elementFor(pos.blockId);
    return el ? positionToDom(el, pos) : null;
  }

  private readDomSelection(): Selection | null {
    const sel = this.root.ownerDocument.getSelection();
    if (!sel || !sel.anchorNode || !sel.focusNode) return null;
    if (!this.root.contains(sel.anchorNode) || !this.root.contains(sel.focusNode)) return null;
    const anchor = domToPosition(this.root, sel.anchorNode, sel.anchorOffset);
    const focus = domToPosition(this.root, sel.focusNode, sel.focusOffset);
    if (!anchor || !focus) return null;
    return { anchor, focus };
  }

  private onSelectionChange(): void {
    if (this.composing || this.destroyed) return;
    const selection = this.readDomSelection();
    if (!selection) {
      if (!this.hasFocus()) this.updateUi();
      return;
    }
    const cur = this.state.selection;
    if (samePosition(selection.anchor, cur.anchor) && samePosition(selection.focus, cur.focus)) {
      this.updateUi();
      return;
    }
    this.state = { ...this.state, selection, storedMarks: null };
    this.history.breakGroup();
    this.updateUi();
  }

  /** The browser selection is the source of truth when an event starts. */
  private refreshSelection(): void {
    const selection = this.readDomSelection();
    if (selection) this.state = { ...this.state, selection };
  }

  /** The range the browser says an input event affects. */
  private targetRange(e: InputEvent): Selection | null {
    const r = e.getTargetRanges?.()[0];
    if (!r) return null;
    const anchor = domToPosition(this.root, r.startContainer, r.startOffset);
    const focus = domToPosition(this.root, r.endContainer, r.endOffset);
    return anchor && focus ? { anchor, focus } : null;
  }

  // -------------------------------------------------------------------------
  // Input

  /** Events from the code-language input and other form controls inside the root are not editor input. */
  private fromControl(e: Event): boolean {
    return e.target instanceof HTMLInputElement;
  }

  private onBeforeInput(e: InputEvent): void {
    if (this.fromControl(e)) return;
    if (this.composing || e.isComposing) return;
    const type = e.inputType;
    if (type === 'insertCompositionText' || type === 'deleteCompositionText' || type === 'insertFromComposition') return;

    e.preventDefault();
    if (this.readOnly) return;
    this.refreshSelection();

    switch (type) {
      case 'insertText': {
        const text = e.data ?? '';
        if (text) this.typeText(text);
        return;
      }
      case 'insertReplacementText': {
        const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? '';
        const range = this.targetRange(e);
        this.run((s) => cmd.insertText(range ? { ...s, selection: range } : s, text));
        return;
      }
      case 'insertParagraph':
        this.run(cmd.splitBlock);
        return;
      case 'insertLineBreak':
        this.run(cmd.insertLineBreak);
        return;
      case 'deleteContentBackward':
        this.run(cmd.deleteBackward);
        return;
      case 'deleteContentForward':
        this.run(cmd.deleteForward);
        return;
      case 'deleteWordBackward':
      case 'deleteWordForward':
      case 'deleteSoftLineBackward':
      case 'deleteSoftLineForward':
      case 'deleteHardLineBackward':
      case 'deleteHardLineForward':
      case 'deleteEntireSoftLine': {
        if (!isCollapsed(this.state.selection)) {
          this.run(cmd.deleteSelection);
          return;
        }
        const range = this.targetRange(e);
        if (range && !isCollapsed(range) && range.anchor.blockId === range.focus.blockId) {
          this.run((s) => cmd.deleteSelection({ ...s, selection: range }));
        } else {
          this.run(type.endsWith('Backward') ? cmd.deleteBackward : cmd.deleteForward);
        }
        return;
      }
      case 'historyUndo':
        this.undo();
        return;
      case 'historyRedo':
        this.redo();
        return;
      case 'formatBold':
        this.toggleMark('bold');
        return;
      case 'formatItalic':
        this.toggleMark('italic');
        return;
      case 'formatStrikeThrough':
        this.toggleMark('strike');
        return;
      default:
        // Paste, cut and drop have their own handlers. Everything else is ignored
        // so the browser never changes the DOM behind the model's back.
        return;
    }
  }

  private typeText(text: string): void {
    this.run((s) => cmd.insertText(s, text), 'typing');
    // Shortcuts are separate undo steps, so undo restores the typed characters.
    if (text === ' ' || text === '-') this.run((s) => cmd.applyBlockInputRules(s));
    if (text.length === 1 && '*_`~'.includes(text)) this.run((s) => cmd.applyInlineInputRules(s));
    if (SLASH_CHARS.includes(text)) this.maybeOpenSlash();
  }

  private onCompositionStart(e: Event): void {
    if (this.fromControl(e)) return;
    this.refreshSelection();
    // Replace a non-collapsed selection before the browser starts composing,
    // so the composition always happens inside one block.
    if (!isCollapsed(this.state.selection)) this.run(cmd.deleteSelection);
    this.composing = true;
    this.toolbar?.hide();
  }

  private onCompositionEnd(e: Event): void {
    if (this.fromControl(e)) return;
    this.composing = false;
    // A committed composition is its own undo step.
    const before = this.state;
    this.reconcileFromDom('other');
    // A full-width slash typed with an IME opens the slash menu too.
    if (this.state !== before) {
      const pos = this.state.selection.focus;
      const content = containerContent(getBlock(this.state.doc, pos.blockId), pos.cell);
      const ch = content ? inlineText(content)[pos.offset - 1] : undefined;
      if (ch && SLASH_CHARS.includes(ch)) this.maybeOpenSlash();
    }
  }

  private onInput(e: InputEvent): void {
    if (this.fromControl(e)) return;
    if (this.composing || e.isComposing) return;
    // Only reached when the browser changed the DOM despite beforeinput.
    this.reconcileFromDom('typing');
  }

  /**
   * Reads text back from the DOM and applies the difference to the model as
   * one delete and one insert per changed text container.
   */
  private reconcileFromDom(kind: ChangeKind): void {
    let state = this.state;
    let changed = false;
    for (const block of state.doc.blocks) {
      let blockChanged = false;
      const el = this.renderer.elementFor(block.id);
      if (!el || !el.isConnected) continue;
      const containers: { cell?: { row: number; col: number } }[] =
        block.type === 'table'
          ? block.rows.flatMap((row, r) => row.map((_, c) => ({ cell: { row: r, col: c } })))
          : block.type === 'divider'
            ? []
            : [{}];
      for (const { cell } of containers) {
        const contentEl = contentElement(el, cell);
        const content = containerContent(getBlock(state.doc, block.id), cell);
        if (!contentEl || !content) continue;
        const oldText = inlineText(content);
        const newText = domText(contentEl);
        if (oldText === newText) continue;
        let start = 0;
        while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
        let endOld = oldText.length;
        let endNew = newText.length;
        while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
          endOld--;
          endNew--;
        }
        const inserted = newText.slice(start, endNew);
        const at: Position = cell ? { blockId: block.id, offset: start, cell } : { blockId: block.id, offset: start };
        state = cmd.deleteRange(state, at, { ...at, offset: endOld });
        if (inserted) state = cmd.insertText({ ...state, storedMarks: this.state.storedMarks }, inserted);
        blockChanged = true;
      }
      if (blockChanged) {
        this.renderer.invalidate(block.id);
        changed = true;
      }
    }
    if (!changed) {
      // Text is unchanged but the browser may have altered structure.
      this.renderer.render(this.state.doc, true);
      this.applyReadOnly();
      this.syncDomSelection();
      return;
    }
    const selection = this.readDomSelection() ?? state.selection;
    this.apply({ ...state, selection: clampSelection(state.doc, selection) }, kind);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.fromControl(e)) return;
    if (e.isComposing || e.keyCode === 229) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    const handled = (fn: () => unknown) => {
      e.preventDefault();
      this.refreshSelection();
      fn();
    };

    // Open menus take the navigation keys.
    const menu = this.openMenu();
    if (menu) {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) return handled(() => this.moveMenu(menu, 1));
      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) return handled(() => this.moveMenu(menu, -1));
      if (e.key === 'Enter') {
        if (menu.count > 0) return handled(() => menu.pick());
        if (menu === this.slashMenu) this.closeSlash();
      }
      if (e.key === 'Escape') return handled(() => (menu === this.slashMenu ? this.closeSlash() : this.closeBlockMenu()));
    }

    if (e.key === 'Escape') {
      this.toolbar?.hide();
      return;
    }
    if (this.readOnly) return;

    if (mod && e.key === 'Enter' && this.options.onSubmit) {
      return handled(() => {
        this.flushChange();
        this.options.onSubmit?.(this.getMarkdown(), this);
      });
    }
    if (mod && !e.altKey) {
      if (key === 'z' && !e.shiftKey) return handled(() => this.undo());
      if ((key === 'z' && e.shiftKey) || (key === 'y' && !isMac)) return handled(() => this.redo());
      if (key === 'b' && !e.shiftKey) return handled(() => this.toggleMark('bold'));
      if (key === 'i' && !e.shiftKey) return handled(() => this.toggleMark('italic'));
      if (key === 'e' && !e.shiftKey) return handled(() => this.toggleMark('code'));
      if (key === 'x' && e.shiftKey) return handled(() => this.toggleMark('strike'));
      if (key === 'k' && !e.shiftKey) return handled(() => this.openLinkPopover());
      if (e.key === '/' && !e.shiftKey && this.hasBlockMenu(this.state.selection.focus.blockId)) {
        return handled(() => this.openBlockMenu(this.state.selection.focus.blockId));
      }
      if (key === 'v' && e.shiftKey) {
        // The paste event that follows inserts plain text.
        this.plainPasteNext = true;
        return;
      }
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !mod && !e.shiftKey && !e.altKey) {
      // On the last line of a final code block or table (or the first line of
      // a first one), add a paragraph past it. Elsewhere the browser moves the caret.
      this.refreshSelection();
      const next = cmd.exitBlock(this.state, e.key === 'ArrowDown' ? 1 : -1);
      if (next !== this.state) return handled(() => this.run(() => next));
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      return handled(() => {
        const block = getBlock(this.state.doc, this.state.selection.focus.blockId);
        if (block.type === 'table') this.run((s) => cmd.moveCell(s, e.shiftKey ? -1 : 1));
        else this.run((s) => cmd.indentListItems(s, e.shiftKey ? -1 : 1));
      });
    }
  }

  private moveMenu(menu: Menu, delta: number): void {
    menu.move(delta);
    this.syncActiveDescendant();
  }

  private onMouseDown(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target === this.root && e.button === 0 && !this.readOnly && this.clickBelowLastBlock(e)) return;
    if (target.classList?.contains('mbe-checkbox')) {
      // Toggle in the model; keep the caret where it is.
      e.preventDefault();
      const blockEl = target.closest<HTMLElement>('[data-block-id]');
      if (blockEl && !this.readOnly) this.run((s) => cmd.toggleTask(s, blockEl.dataset.blockId!));
    }
  }

  /**
   * A click in the empty space below a final code block, table or divider
   * adds a paragraph there. The browser would put the caret inside the
   * block, or in the block above a table.
   */
  private clickBelowLastBlock(e: MouseEvent): boolean {
    const blocks = this.state.doc.blocks;
    const last = blocks[blocks.length - 1];
    if (!last || (last.type !== 'code' && last.type !== 'table' && last.type !== 'divider')) return false;
    const el = this.root.querySelector<HTMLElement>(`:scope > [data-block-id="${last.id}"]`);
    if (!el || e.clientY <= el.getBoundingClientRect().bottom) return false;
    e.preventDefault();
    this.root.focus({ preventScroll: true });
    const end = endOf(last);
    this.run((s) => cmd.exitBlock({ ...s, selection: { anchor: end, focus: end } }, 1));
    return true;
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.classList?.contains('mbe-checkbox')) {
      e.preventDefault();
      return;
    }
    const link = target.closest?.<HTMLAnchorElement>('a.mbe-link');
    if (!link) return;
    // Links open on click when read-only, and on Mod+click while editing.
    e.preventDefault();
    if (this.readOnly || (isMac ? e.metaKey : e.ctrlKey)) {
      const href = safeHref(link.dataset.href ?? '');
      if (href) this.root.ownerDocument.defaultView?.open(href, '_blank', 'noopener,noreferrer');
    }
  }

  /** The code block language input. */
  private onControlChange(e: Event): void {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains('mbe-code-lang')) return;
    const blockEl = input.closest<HTMLElement>('[data-block-id]');
    if (blockEl) this.run((s) => cmd.setCodeLanguage(s, blockEl.dataset.blockId!, input.value.trim()));
  }

  private onFocusIn(): void {
    if (this.focused || !this.hasFocus()) return;
    this.focused = true;
    this.root.classList.add('mbe-focused');
    this.options.onFocus?.(this);
    this.updateUi();
  }

  private onFocusOut(e: FocusEvent): void {
    const next = e.relatedTarget as Node | null;
    if (next && (this.root.contains(next) || this.linkPopover.contains(next))) return;
    // Focus may move between table cells and the root; check after it settles.
    queueMicrotask(() => {
      if (this.hasFocus() || this.linkPopover.isOpen) return;
      if (!this.focused) return;
      this.focused = false;
      this.root.classList.remove('mbe-focused');
      this.hideUi();
      this.flushChange();
      this.options.onBlur?.(this);
    });
  }

  private onScroll(): void {
    this.handle.hide();
    if (this.slashMenu.isOpen || this.toolbar?.isOpen || this.blockMenu.isOpen) this.updateUi();
  }

  // -------------------------------------------------------------------------
  // Clipboard

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (this.fromControl(e)) return;
    this.refreshSelection();
    if (isCollapsed(this.state.selection) || !e.clipboardData) return;
    e.preventDefault();
    const doc: Doc = { blocks: cmd.selectedBlocks(this.state) };
    const markdown = serializeMarkdown(doc).replace(/\n$/, '');
    e.clipboardData.setData('text/plain', markdown);
    e.clipboardData.setData('text/html', `<meta charset="utf-8"><div data-mbe-markdown="${encodeURIComponent(markdown)}">${docToHtml(doc)}</div>`);
    if (cut && !this.readOnly) this.run(cmd.deleteSelection);
  }

  private onPaste(e: ClipboardEvent): void {
    if (this.fromControl(e)) return;
    e.preventDefault();
    if (this.readOnly) return;
    this.refreshSelection();
    const data = e.clipboardData;
    if (!data) return;
    const text = data.getData('text/plain');
    const html = data.getData('text/html');
    const plainOnly = this.plainPasteNext;
    this.plainPasteNext = false;

    const block = getBlock(this.state.doc, this.state.selection.focus.blockId);
    if (isPlainTextBlock(block)) {
      this.run((s) => cmd.insertText(s, text));
      return;
    }
    if (plainOnly) {
      // Mod+Shift+V: the text as typed, one paragraph per line.
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      this.run((s) => cmd.insertBlocks(s, lines.map((l) => paragraph(plain(l)))));
      return;
    }
    // A URL pasted over selected text makes it a link.
    const url = text.trim();
    if (!isCollapsed(this.state.selection) && /^(https?:\/\/|mailto:)\S+$/i.test(url)) {
      this.run((s) => cmd.setLink(s, url));
      return;
    }

    let fragment: readonly Block[];
    const internal = /data-mbe-markdown="([^"]*)"/.exec(html);
    if (internal) fragment = parseMarkdown(decodeURIComponent(internal[1]!)).blocks;
    else if (html) fragment = htmlToDoc(html).blocks;
    else fragment = parseMarkdown(text).blocks;
    if (fragment.length === 0 && text) fragment = parseMarkdown(text).blocks;
    this.run((s) => cmd.insertBlocks(s, fragment));
  }

  // -------------------------------------------------------------------------
  // Slash menu

  private maybeOpenSlash(): void {
    const pos = this.state.selection.focus;
    const block = getBlock(this.state.doc, pos.blockId);
    if (!isTextBlock(block) || isPlainTextBlock(block) || pos.cell) return;
    const text = inlineText(block.content);
    const before = text[pos.offset - 2];
    // Only at the start of a block or after a space, so URLs and paths do not open it.
    if (before !== undefined && !/\s/.test(before)) return;
    this.slash = { blockId: block.id, from: pos.offset - 1 };
    this.updateUi();
  }

  private closeSlash(): void {
    this.slash = null;
    this.slashMenu.hide();
    this.root.removeAttribute('aria-activedescendant');
    this.root.removeAttribute('aria-controls');
  }

  /** The text typed after "/", or null when the slash menu should close. */
  private slashQuery(): string | null {
    const slash = this.slash;
    if (!slash || !isCollapsed(this.state.selection)) return null;
    const pos = this.state.selection.focus;
    if (pos.blockId !== slash.blockId || pos.offset <= slash.from) return null;
    const block = this.state.doc.blocks.find((b) => b.id === slash.blockId);
    if (!block || !isTextBlock(block)) return null;
    const text = inlineText(block.content);
    if (!SLASH_CHARS.includes(text[slash.from] ?? '')) return null;
    const query = text.slice(slash.from + 1, pos.offset);
    if (query.includes('\n') || /\s\s/.test(query) || query.length > 30) return null;
    return query;
  }

  private slashItems(query: string): MenuItem[] {
    const ids = this.options.slashItems ?? SLASH_ITEM_IDS;
    return ids
      .map((id) => BLOCK_ITEMS.find((b) => b.id === id))
      .filter((b): b is BlockItem => !!b)
      .map<MenuItem>((b) => ({
        id: b.id,
        label: this.labels[b.id],
        icon: b.icon,
        aliases: b.aliases,
        run: () => this.pickSlashItem(b.spec),
      }))
      .filter((item) => matches(item, query));
  }



  private pickSlashItem(spec: cmd.BlockTypeSpec): void {
    const slash = this.slash;
    if (!slash) return;
    const end = this.state.selection.focus.offset;
    const block = getBlock(this.state.doc, slash.blockId);
    const text = isTextBlock(block) ? inlineText(block.content) : '';
    // At the end of a line, also drop the space typed before "/", so
    // "hello /h1" becomes a heading "hello", not "hello ".
    const from = end === text.length && text[slash.from - 1] === ' ' ? slash.from - 1 : slash.from;
    this.closeSlash();
    // Remove "/query", then convert or insert, as one undo step.
    this.run((s) => {
      const removed = cmd.deleteRange(s, { blockId: slash.blockId, offset: from }, { blockId: slash.blockId, offset: end });
      return cmd.insertBlock(removed, spec);
    });
  }

  // -------------------------------------------------------------------------
  // Block menu

  private blockMenuSections(blockId: string): MenuSection[] {
    const block = getBlock(this.state.doc, blockId);
    const sections: MenuSection[] = [];
    if (block.type === 'table' && this.state.selection.focus.blockId === blockId && this.state.selection.focus.cell) {
      sections.push({
        title: this.labels.tableSection,
        items: TABLE_ITEMS.map(({ id, icon, action }) => ({
          id,
          label: this.labels[id],
          icon,
          run: () => this.run((s) => cmd.tableAction(s, action)),
        })),
      });
    }
    sections.push({
      items: [
        { id: 'duplicate', label: this.labels.duplicate, icon: '⧉', run: () => this.run((s) => cmd.duplicateBlock(s, blockId)) },
        { id: 'delete', label: this.labels.delete, icon: '🗑', danger: true, run: () => this.run((s) => cmd.deleteBlock(s, blockId)) },
      ],
    });
    return sections;
  }

  /**
   * Only large blocks get the handle and block menu: tables and code blocks.
   * Other blocks change type through the slash menu or Markdown shortcuts.
   */
  hasBlockMenu(blockId: string): boolean {
    const block = this.state.doc.blocks.find((b) => b.id === blockId);
    return block?.type === 'table' || block?.type === 'code';
  }

  openBlockMenu(blockId: string, anchor?: DOMRect): void {
    if (this.readOnly || !this.hasBlockMenu(blockId)) return;
    this.closeSlash();
    this.toolbar?.hide();
    // Keep the caret in the table cell for table actions; otherwise move it into the block.
    if (this.state.selection.focus.blockId !== blockId) {
      const block = getBlock(this.state.doc, blockId);
      const start = startOf(block);
      this.state = { ...this.state, selection: { anchor: start, focus: start } };
      this.focus();
    }
    this.blockMenu.setSections(this.blockMenuSections(blockId));
    const rect = anchor ?? this.blockElement(blockId)?.getBoundingClientRect();
    if (rect) this.blockMenu.popup.show(rect, 'below');
    this.syncActiveDescendant();
  }

  private closeBlockMenu(): void {
    this.blockMenu.hide();
    this.syncActiveDescendant();
  }

  // -------------------------------------------------------------------------
  // Toolbar and link popover (see ui/toolbar.ts)

  isMarkActive(mark: Mark): boolean {
    return cmd.isMarkActive(this.state, mark);
  }

  activeLinkHref(): string | null {
    return cmd.activeLink(this.state)?.href ?? null;
  }

  openLinkPopover(): void {
    if (this.readOnly) return;
    const block = getBlock(this.state.doc, this.state.selection.focus.blockId);
    if (isPlainTextBlock(block)) return;
    if (isCollapsed(this.state.selection) && !cmd.activeLink(this.state)) return;
    const rect = this.selectionRect();
    if (!rect) return;
    this.toolbar?.hide();
    const saved = this.state.selection;
    this.linkPopover.open(rect, this.activeLinkHref() ?? '', (href) => {
      this.state = { ...this.state, selection: saved };
      if (href !== null) this.run((s) => cmd.setLink(s, href === '' ? null : href));
      this.focus();
    });
  }

  // -------------------------------------------------------------------------
  // UI that follows the selection

  private updateUi(): void {
    if (this.destroyed) return;
    const focused = this.hasFocus();

    // Hint in an empty focused paragraph.
    const pos = this.state.selection.focus;
    const el = focused && isCollapsed(this.state.selection) ? this.renderer.elementFor(pos.blockId) : undefined;
    // The placeholder of an empty document takes precedence over the slash hint.
    const placeholderShown = !!this.options.placeholder && this.state.doc.blocks.length === 1;
    const showHint =
      el && el.classList.contains('mbe-paragraph') && el.classList.contains('mbe-empty') && !this.readOnly && !placeholderShown;
    const nextHint = showHint ? el : null;
    if (this.hintEl !== nextHint) {
      this.hintEl?.classList.remove('mbe-show-hint');
      nextHint?.classList.add('mbe-show-hint');
      this.hintEl = nextHint;
    }

    // Slash menu.
    const query = focused && !this.composing ? this.slashQuery() : null;
    if (query === null) {
      if (this.slash) this.closeSlash();
    } else {
      const items = this.slashItems(query);
      // Close after a few characters that match nothing, so typing continues normally.
      if (items.length === 0 && query.length > 3) {
        this.closeSlash();
      } else {
        // Rebuild only when the query changed, so a late selectionchange does
        // not reset the item the user just moved to with the arrow keys.
        if (!this.slashMenu.isOpen || this.slash!.query !== query) {
          this.slashMenu.setSections([{ items }], this.labels.noResults);
          this.slash!.query = query;
        }
        const rect = this.selectionRect();
        if (rect) this.slashMenu.popup.show(rect, 'below');
        this.root.setAttribute('aria-controls', this.slashMenu.el.id);
      }
    }

    // Formatting toolbar.
    if (this.toolbar) {
      const block = this.state.doc.blocks.find((b) => b.id === pos.blockId);
      const show =
        focused &&
        !this.readOnly &&
        !this.composing &&
        !isCollapsed(this.state.selection) &&
        !this.slash &&
        !this.blockMenu.isOpen &&
        !!block &&
        !isPlainTextBlock(block) &&
        block.type !== 'divider';
      if (show) this.toolbar.show();
      else this.toolbar.hide();
    }
    // On touch devices there is no hover, so the handle follows the caret.
    if (focused && !this.readOnly && isTouch()) {
      if (this.hasBlockMenu(pos.blockId)) this.handle.showFor(pos.blockId);
      else this.handle.hide();
    }
    if (!focused && this.blockMenu.isOpen && !this.root.ownerDocument.activeElement?.closest?.('.mbe-ui')) this.blockMenu.hide();
    this.syncActiveDescendant();
  }

  private openMenu(): Menu | null {
    return this.slashMenu.isOpen ? this.slashMenu : this.blockMenu.isOpen ? this.blockMenu : null;
  }

  private syncActiveDescendant(): void {
    const id = this.openMenu()?.activeDescendant;
    if (id) this.root.setAttribute('aria-activedescendant', id);
    else this.root.removeAttribute('aria-activedescendant');
  }

  private hideUi(): void {
    this.closeSlash();
    this.blockMenu.hide();
    this.toolbar?.hide();
    this.handle.hide();
    this.hintEl?.classList.remove('mbe-show-hint');
    this.hintEl = null;
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, capture = false): void {
    target.addEventListener(type, fn, capture);
    this.cleanup.push(() => target.removeEventListener(type, fn, capture));
  }
}
