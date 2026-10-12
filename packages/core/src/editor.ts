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
import { serializeBlocks, serializeMarkdown } from './markdown/serialize';
import { type MarkdownSource, loadMarkdown } from './markdown/source';
import { type MarkdownOptions, type ResolvedMarkdown, resolveMarkdown } from './markdown/options';
import type { Extension } from './extension';
import { defaultKeymap } from './extensions/keymap';
import { decorationContext } from './decorations';
import type { SuggestionConfig, SuggestionItem } from './extensions/suggestion';
import { type Widget, WidgetImpl, type WidgetRender } from './widgets';
import { type Binding, matchesKey, parseKeyName } from './keymap';
import {
  type Block,
  type Doc,
  type EditorState,
  type HeadingLevel,
  type Mark,
  type Position,
  type Selection,
  blockIndex,
  clampSelection,
  containerContent,
  createState,
  endOf,
  getBlock,
  inlineLength,
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
import { Menu, type MenuSection, isMac, isTouch, matches } from './ui/popup';
import { BLOCK_ATTR, BlockRenderer, childIndex, contentElement, domText, domToPosition, positionToDom, safeHref } from './view/dom';
import { revealedViews, sameRevealed, viewEntry } from './view/reveal';
import { type Theme, mergeClasses, tokenProperties } from './theme';

export interface EditorOptions {
  /** The element the editor renders into. */
  element: HTMLElement;
  /** Initial Markdown. */
  content?: string;
  /** Markdown dialect: `breaks` and `setext`. Fixed for the editor's lifetime. */
  markdown?: MarkdownOptions;
  /** Extensions, such as `math()` and `footnotes()`. Earlier extensions take priority. Fixed for the editor's lifetime. */
  extensions?: readonly Extension[];
  /** Shown when the document is empty. */
  placeholder?: string;
  /** Default true. */
  editable?: boolean;
  /** Focus on creation: `true` or `'start'` puts the caret at the start, `'end'` at the end. */
  autofocus?: boolean | 'start' | 'end';
  /** Attributes for the editable root, such as `autocorrect` or `aria-label`. */
  attributes?: Readonly<Record<string, string>>;
  /** Maps an image `src` to the URL to display. The saved Markdown keeps the original `src`. */
  resolveImageSrc?: (src: string) => string;
  /** Classes for rendered elements, colors and fonts, and the color scheme. See `Theme`. */
  theme?: Theme;
  /** Overrides UI strings. */
  labels?: Partial<Labels>;
  /** Shows the formatting toolbar on selection. Default true. */
  toolbar?: boolean;
  /** IDs of built-in slash menu items to show, in order, or false for no slash menu. See SLASH_ITEM_IDS. */
  slashMenu?: false | readonly SlashItemId[];
  /** Shortcut for `on('change')`, with the new Markdown. */
  onChange?: (markdown: string, editor: Editor) => void;
  /** Shortcut for `on('submit')`, with the current Markdown. */
  onSubmit?: (markdown: string, editor: Editor) => void;
  onFocus?: (editor: Editor) => void;
  onBlur?: (editor: Editor) => void;
}

/** Options that `setOptions` can change while the editor runs. */
export type RuntimeOptions = Pick<EditorOptions, 'placeholder' | 'editable' | 'attributes' | 'resolveImageSrc' | 'theme'>;

export interface EditorEvents {
  /** After document changes, at most once per animation frame. */
  change: { editor: Editor };
  /** The selection moved or the document changed. */
  selectionChange: { editor: Editor };
  focus: { editor: Editor; event: FocusEvent };
  blur: { editor: Editor; event: FocusEvent };
  /** Mod-Enter or Ctrl-Enter. */
  submit: { editor: Editor };
}

/** Names `isActive` and `getAttributes` understand. */
export type ActiveName =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | 'paragraph'
  | 'heading'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'codeBlock'
  | 'table'
  | 'divider'
  | 'raw';

/** A position that survives reloading the same Markdown: a block index and an offset. */
export interface PositionJSON {
  readonly block: number;
  readonly offset: number;
  readonly cell?: { readonly row: number; readonly col: number };
}

export interface SelectionJSON {
  readonly anchor: PositionJSON;
  readonly focus: PositionJSON;
}

/** Where `insertMarkdown` inserts. A widget means after the widget's block. */
export type InsertTarget = 'selection' | 'end' | Position | Widget;

export interface InsertMarkdownOptions {
  /** Default `'selection'`, which replaces the selection like a paste. A position, a widget or `'end'` replaces nothing. */
  at?: InsertTarget;
  /** Insert as separate blocks even when the Markdown is a single paragraph. Default false. */
  block?: boolean;
  /** `'end'` (default) puts the caret after the inserted content; `'keep'` keeps the selection. */
  select?: 'end' | 'keep';
}

/** Commands on `editor.commands`. Each applies one change, records one undo step, and returns true if it did something. */
export interface EditorCommands {
  toggleBold(): boolean;
  toggleItalic(): boolean;
  toggleStrike(): boolean;
  toggleCode(): boolean;
  setParagraph(): boolean;
  toggleHeading(attrs: { level: HeadingLevel }): boolean;
  toggleBulletList(): boolean;
  toggleOrderedList(): boolean;
  toggleTaskList(): boolean;
  toggleBlockquote(): boolean;
  toggleCodeBlock(attrs?: { language?: string }): boolean;
  setLink(attrs: { href: string }): boolean;
  unsetLink(): boolean;
  /** Inserts plain text at the selection, or in place of `range` (for example a suggestion's range). */
  insertText(text: string, options?: { range?: { from: Position; to: Position } }): boolean;
  insertMarkdown(markdown: string, options?: InsertMarkdownOptions): boolean;
  insertTable(attrs?: { rows?: number; cols?: number }): boolean;
  insertDivider(): boolean;
  indent(): boolean;
  outdent(): boolean;
  undo(): boolean;
  redo(): boolean;
  selectAll(): boolean;
  /** Selects the blocks the selection touches as whole blocks (block selection). Escape does this. */
  selectBlocks(): boolean;
  focus(position?: 'start' | 'end' | Position): boolean;
  blur(): boolean;
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

interface SlashItem extends SuggestionItem {
  readonly id: SlashItemId;
  readonly aliases: string[];
  readonly spec: cmd.BlockTypeSpec;
}

export class Editor {
  readonly root: HTMLElement;
  readonly labels: Labels;
  readonly commands: EditorCommands;
  private current: EditorState;
  /** The Markdown the document was loaded from; unchanged blocks are saved as this text. */
  private source: MarkdownSource;
  /** The Markdown dialect: options plus the syntax of extensions. */
  private readonly markdown: ResolvedMarkdown;
  private readonly history = new History();
  private readonly renderer: BlockRenderer;
  private composing = false;
  private readOnly: boolean;
  private wasReadOnly = false;
  private readonly options: EditorOptions;
  /** The extensions in priority order, ending with the default keymap unless one was given. */
  private readonly extensions: readonly Extension[];
  private readonly bindings: readonly Binding[];
  private runtime: RuntimeOptions;
  /** The merged theme classes, serialized, to skip re-rendering when they did not change. */
  private classesKey = '{}';
  /** Custom properties the theme's tokens set on the root. */
  private tokenNames: readonly string[] = [];
  private readonly listeners = new Map<keyof EditorEvents, Set<(payload: never) => void>>();
  private readonly cleanup: (() => void)[] = [];
  private widgets: WidgetImpl[] = [];
  private changeFrame: number | null = null;
  private plainPasteNext = false;
  private destroyed = false;
  private focused = false;
  /** A mouse button is down in the editor. Rendered views keep their state until it is released, so a drag is not disturbed. */
  private pointerDown = false;

  /** Suggestion menus from extensions, then the slash menu. */
  private readonly suggestions: { readonly config: SuggestionConfig; readonly menu: Menu }[];
  /** The open suggestion: which one, where its trigger is, and the last query shown. */
  private suggest: { index: number; blockId: string; from: number; query?: string; request: number } | null = null;
  private readonly blockMenu: Menu;
  private readonly toolbar: FormatToolbar | null;
  private readonly linkPopover: LinkPopover;
  private readonly handle: BlockHandle;
  private hintEl: HTMLElement | null = null;
  /**
   * The block selection, by block ID, or null for a text selection. While it
   * is set, the model selection spans the selected blocks, so block type,
   * indent and mark commands apply to all of them, and the browser selection
   * is a hidden caret at the start of the head block.
   */
  private blockSel: { anchor: string; head: string } | null = null;
  /** Block elements that carry the selected class. */
  private selectedEls: HTMLElement[] = [];

  constructor(options: EditorOptions) {
    const root = options.element;
    this.root = root;
    this.options = options;
    this.runtime = {};
    this.labels = { ...DEFAULT_LABELS, ...options.labels };
    this.readOnly = options.editable === false;
    const given = options.extensions ?? [];
    this.extensions = given.some((e) => e.name === 'defaultKeymap') ? given : [...given, defaultKeymap()];
    this.bindings = this.extensions.flatMap((ext) =>
      Object.entries(ext.keymap ?? {}).map(([name, handler]) => parseKeyName(name, handler, isMac)),
    );
    const syntax = given.flatMap((e) => (e.markdown ? [e.markdown] : []));
    this.markdown = resolveMarkdown({ ...options.markdown, syntax: [...(options.markdown?.syntax ?? []), ...syntax] });
    const loaded = loadMarkdown(options.content ?? '', this.markdown);
    this.source = loaded.source;
    this.current = createState(loaded.doc);
    this.renderer = new BlockRenderer(root, this.labels);
    this.renderer.widgetsAfter = (blockId) => {
      if (this.widgets.length === 0) return undefined;
      const els = this.widgets.filter((w) => w.blockId === blockId).map((w) => w.element);
      return els.length ? els : undefined;
    };
    const views = new Map(this.extensions.flatMap((e) => Object.entries(e.views ?? {})));
    if (views.size > 0) this.renderer.views = views;
    const decorators = this.extensions.flatMap((e) => (e.decorations ? [e.decorations] : []));
    if (decorators.length > 0) {
      this.renderer.decorate = (block, content, cell) => {
        const ctx = decorationContext(block, content, cell);
        return decorators.flatMap((fn) => fn(ctx));
      };
    }
    this.commands = this.createCommands();

    root.classList.add('mbe-root');
    root.setAttribute('role', 'textbox');
    root.setAttribute('aria-multiline', 'true');
    root.spellcheck = true;
    root.translate = false;
    root.style.setProperty('--mbe-slash-hint', JSON.stringify(this.labels.slashHint));
    this.applyRuntime({ placeholder: options.placeholder, attributes: options.attributes });
    this.runtime = { ...this.runtime, resolveImageSrc: options.resolveImageSrc };
    this.renderer.resolveImageSrc = options.resolveImageSrc;
    this.applyTheme(options.theme);

    const configs = this.extensions.flatMap((e) => (e.suggestion ? [e.suggestion] : []));
    if (options.slashMenu !== false) configs.push(this.slashSuggestion() as unknown as SuggestionConfig);
    this.suggestions = configs.map((config) => ({
      config,
      menu: new Menu(root, `mbe-suggestion-menu ${config.className ?? ''}`.trim(), 'listbox'),
    }));
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
    this.listen(root, 'dragover', (e) => {
      if (!this.readOnly) e.preventDefault();
    });
    this.listen(root, 'drop', (e) => this.onDrop(e as DragEvent));
    this.listen(root, 'mousedown', (e) => this.onMouseDown(e as MouseEvent));
    this.listen(root, 'click', (e) => this.onClick(e as MouseEvent));
    this.listen(root, 'change', (e) => this.onControlChange(e));
    this.listen(root, 'focusin', (e) => this.onFocusIn(e as FocusEvent));
    this.listen(root, 'focusout', (e) => this.onFocusOut(e as FocusEvent));
    this.listen(root.ownerDocument, 'selectionchange', () => this.onSelectionChange());
    this.listen(root.ownerDocument, 'mouseup', () => this.onMouseUp());
    this.listen(root.ownerDocument, 'scroll', () => this.onScroll(), true);

    this.paint(true, true);
    this.afterRender();
    for (const ext of this.extensions) {
      const dispose = ext.onCreate?.({ editor: this });
      if (typeof dispose === 'function') this.cleanup.push(dispose);
    }
    if (options.autofocus) this.commands.focus(options.autofocus === 'end' ? 'end' : 'start');
  }

  // -------------------------------------------------------------------------
  // Content

  /** The document as Markdown. Blocks that were not edited are written exactly as they were loaded. */
  getMarkdown(): string {
    return serializeMarkdown(this.current.doc, { ...this.markdown, source: this.source });
  }

  /**
   * Replaces the whole document. Does not emit `change`. By default clears
   * undo history; with `history: 'keep'` the replacement is one undo step.
   */
  setMarkdown(markdown: string, options: { history?: 'clear' | 'keep' } = {}): void {
    if (options.history === 'keep') this.history.record(this.current, 'other');
    else this.history.clear();
    const loaded = loadMarkdown(markdown, this.markdown);
    this.source = loaded.source;
    this.blockSel = null;
    const next = createState(loaded.doc);
    this.relocateWidgets(this.current.doc, next.doc, true);
    this.current = next;
    this.paint(true, true);
    this.afterRender();
    this.emit('selectionChange', { editor: this });
  }

  /** True when the document holds only empty paragraphs. */
  get isEmpty(): boolean {
    return this.current.doc.blocks.every((b) => b.type === 'paragraph' && inlineLength(b.content) === 0);
  }

  // -------------------------------------------------------------------------
  // State and selection

  /** The document and selection. Immutable; every change replaces it. */
  get state(): EditorState {
    return this.current;
  }

  /** True while an input method (IME) is composing text. Replacing the document now would break the composition. */
  get isComposing(): boolean {
    return this.composing;
  }

  get isEditable(): boolean {
    return !this.readOnly;
  }

  /** True if `name` applies at the selection: a mark on the selected text, or the type of the block with the caret. */
  isActive(name: ActiveName, attrs?: Readonly<Record<string, unknown>>): boolean {
    const s = this.current;
    switch (name) {
      case 'bold':
      case 'italic':
      case 'strike':
      case 'code':
        return cmd.isMarkActive(s, name);
      case 'link':
        return cmd.activeLink(s) !== null;
    }
    const block = getBlock(s.doc, s.selection.focus.blockId);
    if (blockName(block) !== name) return false;
    if (!attrs) return true;
    const actual = this.getAttributes(name);
    return Object.entries(attrs).every(([k, v]) => actual[k] === v);
  }

  /** Attributes of `name` at the selection: `href` for a link, `level` for a heading, `language` for a code block, `checked` for a task, `syntax` for a raw block. */
  getAttributes(name: ActiveName): Record<string, unknown> {
    const s = this.current;
    if (name === 'link') {
      const link = cmd.activeLink(s);
      return link ? { href: link.href } : {};
    }
    const block = getBlock(s.doc, s.selection.focus.blockId);
    if (blockName(block) !== name) return {};
    switch (block.type) {
      case 'heading':
        return { level: block.level };
      case 'code':
        return { language: block.language };
      case 'listItem':
        return block.listType === 'task' ? { checked: block.checked, indent: block.indent } : { indent: block.indent };
      case 'raw':
        return { syntax: block.syntax };
      default:
        return {};
    }
  }

  getSelection(): Selection {
    return this.current.selection;
  }

  /**
   * Moves the selection. Accepts a Selection or a SelectionJSON. A value
   * that does not fit the document is clamped to the nearest valid position;
   * a value that is not a selection at all is ignored and returns false.
   */
  setSelection(selection: Selection | SelectionJSON): boolean {
    const sel = isSelection(selection) ? clampSelection(this.current.doc, selection) : selectionFromJSON(this.current.doc, selection);
    if (!sel) return false;
    this.dropBlockSelection();
    this.current = { ...this.current, selection: sel, storedMarks: null };
    this.history.breakGroup();
    this.refreshRevealed();
    this.syncDomSelection();
    this.updateUi();
    this.emit('selectionChange', { editor: this });
    return true;
  }

  /** The selection as JSON-safe data that survives reloading the same Markdown. */
  selectionToJSON(): SelectionJSON {
    const doc = this.current.doc;
    const toJSON = (p: Position): PositionJSON => {
      const block = blockIndex(doc, p.blockId);
      return p.cell ? { block, offset: p.offset, cell: { row: p.cell.row, col: p.cell.col } } : { block, offset: p.offset };
    };
    return { anchor: toJSON(this.current.selection.anchor), focus: toJSON(this.current.selection.focus) };
  }

  hasFocus(): boolean {
    const active = this.root.ownerDocument.activeElement;
    return !!active && this.root.contains(active) && !(active instanceof HTMLInputElement) && !active.closest('.mbe-widget');
  }

  // -------------------------------------------------------------------------
  // Widgets

  /**
   * Shows app UI after the block that contains `at`. The widget is never
   * saved and is not part of undo history. It moves with its block; if the
   * block is deleted, it moves to the nearest remaining block.
   */
  addWidget(options: { at: Position | 'end'; render: WidgetRender }): Widget {
    const blocks = this.current.doc.blocks;
    const at = options.at === 'end' ? endOf(blocks[blocks.length - 1]!) : options.at;
    const blockId = clampSelection(this.current.doc, { anchor: at, focus: at }).focus.blockId;
    const el = this.root.ownerDocument.createElement('div');
    el.className = 'mbe-widget';
    el.contentEditable = 'false';
    const widget = new WidgetImpl(el, blockId, options.render, (w) => {
      this.widgets = this.widgets.filter((x) => x !== w);
    });
    this.widgets.push(widget);
    this.paint();
    return widget;
  }

  /**
   * Moves widgets whose block is gone. `byIndex` (after setMarkdown, when
   * every block is new) keeps the same block index; otherwise a widget moves
   * to the nearest earlier block that remains, or else the nearest later one.
   */
  private relocateWidgets(prev: Doc, next: Doc, byIndex: boolean): void {
    if (this.widgets.length === 0) return;
    const ids = new Set(next.blocks.map((b) => b.id));
    for (const widget of this.widgets) {
      if (ids.has(widget.blockId)) continue;
      const index = prev.blocks.findIndex((b) => b.id === widget.blockId);
      let target: string | undefined;
      if (byIndex) {
        target = next.blocks[Math.max(0, Math.min(index, next.blocks.length - 1))]!.id;
      } else {
        for (let i = index - 1; i >= 0 && !target; i--) if (ids.has(prev.blocks[i]!.id)) target = prev.blocks[i]!.id;
        for (let i = index + 1; i < prev.blocks.length && !target && index >= 0; i++) if (ids.has(prev.blocks[i]!.id)) target = prev.blocks[i]!.id;
      }
      widget.blockId = target ?? next.blocks[0]!.id;
    }
  }

  /** Focuses the editor at the current selection. */
  focus(): void {
    const pos = this.current.selection.focus;
    const el = this.renderer.elementFor(pos.blockId);
    const host = pos.cell && el ? contentElement(el, pos.cell) : this.root;
    (host ?? this.root).focus({ preventScroll: true });
    this.syncDomSelection(true);
  }

  blur(): void {
    if (this.hasFocus()) (this.root.ownerDocument.activeElement as HTMLElement | null)?.blur();
  }

  // -------------------------------------------------------------------------
  // Options and events

  /** Changes `placeholder`, `editable`, `attributes`, `resolveImageSrc` or `theme`. */
  setOptions(options: RuntimeOptions): void {
    if (options.editable !== undefined && options.editable === this.readOnly) {
      this.readOnly = !options.editable;
      this.refreshRevealed();
      this.applyReadOnly();
      this.hideUi();
    }
    this.applyRuntime(options);
  }

  /** Subscribes to an event. Returns a function that unsubscribes. */
  on<K extends keyof EditorEvents>(type: K, handler: (payload: EditorEvents[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(handler);
    return () => void set.delete(handler);
  }

  private emit<K extends keyof EditorEvents>(type: K, payload: EditorEvents[K]): void {
    const set = this.listeners.get(type) as Set<(payload: EditorEvents[K]) => void> | undefined;
    if (set) for (const fn of [...set]) fn(payload);
  }

  private applyRuntime(options: RuntimeOptions): void {
    const root = this.root;
    if ('placeholder' in options) {
      if (options.placeholder) root.style.setProperty('--mbe-placeholder', JSON.stringify(options.placeholder));
      else root.style.removeProperty('--mbe-placeholder');
      this.runtime = { ...this.runtime, placeholder: options.placeholder };
    }
    if ('attributes' in options) {
      for (const name of Object.keys(this.runtime.attributes ?? {})) root.removeAttribute(name);
      for (const [name, value] of Object.entries(options.attributes ?? {})) root.setAttribute(name, value);
      this.runtime = { ...this.runtime, attributes: options.attributes };
    }
    if ('resolveImageSrc' in options && options.resolveImageSrc !== this.runtime.resolveImageSrc) {
      this.runtime = { ...this.runtime, resolveImageSrc: options.resolveImageSrc };
      this.renderer.resolveImageSrc = options.resolveImageSrc;
      this.paint(true);
    }
    if ('theme' in options && this.applyTheme(options.theme)) this.paint(true);
  }

  /** Sets the theme. Returns true when blocks must re-render for new classes. */
  private applyTheme(theme: Theme | undefined): boolean {
    this.runtime = { ...this.runtime, theme };
    // Tokens and the color scheme are custom properties and CSS: no re-render.
    const style = this.root.style;
    const props = tokenProperties(theme?.tokens);
    for (const name of this.tokenNames) if (!props.has(name)) style.removeProperty(name);
    for (const [name, value] of props) style.setProperty(name, value);
    this.tokenNames = [...props.keys()];
    const scheme = theme?.colorScheme ?? 'auto';
    style.colorScheme = scheme === 'auto' ? '' : scheme;
    // Earlier extensions win over later ones, and the editor's own theme over all.
    const classes = mergeClasses([...this.extensions.map((e) => e.theme?.classes).reverse(), theme?.classes]);
    const key = JSON.stringify(classes);
    if (key === this.classesKey) return false;
    this.classesKey = key;
    this.renderer.classes = classes;
    return true;
  }

  // -------------------------------------------------------------------------
  // Commands

  /** Applies a command (a pure function of the state), records history, re-renders, and emits events. */
  run(command: (state: EditorState) => EditorState | null, kind: ChangeKind = 'other'): boolean {
    if (this.readOnly) return false;
    let next = command(this.current);
    if (!next || next === this.current) return false;
    // A command that rebuilt the block list without changing any block changed nothing.
    if (next.doc !== this.current.doc && sameBlocks(next.doc, this.current.doc)) next = { ...next, doc: this.current.doc };
    if (next.doc === this.current.doc && next.selection === this.current.selection && next.storedMarks === this.current.storedMarks) {
      return false;
    }
    this.apply(next, kind);
    return true;
  }

  private createCommands(): EditorCommands {
    const run = (fn: (s: EditorState) => EditorState | null) => this.run(fn);
    const block = (spec: cmd.BlockTypeSpec) => run((s) => cmd.toggleBlockType(s, spec));
    return {
      toggleBold: () => run((s) => cmd.toggleMark(s, 'bold')),
      toggleItalic: () => run((s) => cmd.toggleMark(s, 'italic')),
      toggleStrike: () => run((s) => cmd.toggleMark(s, 'strike')),
      toggleCode: () => run((s) => cmd.toggleMark(s, 'code')),
      setParagraph: () => run((s) => cmd.setBlockType(s, { type: 'paragraph' })),
      toggleHeading: ({ level }) => block({ type: 'heading', level }),
      toggleBulletList: () => block({ type: 'listItem', listType: 'bullet' }),
      toggleOrderedList: () => block({ type: 'listItem', listType: 'ordered' }),
      toggleTaskList: () => block({ type: 'listItem', listType: 'task' }),
      toggleBlockquote: () => block({ type: 'quote' }),
      toggleCodeBlock: (attrs = {}) => block({ type: 'code', language: attrs.language }),
      setLink: ({ href }) => run((s) => cmd.setLink(s, href)),
      unsetLink: () => run((s) => cmd.setLink(s, null)),
      insertText: (text, options = {}) =>
        run((s) => {
          const range = options.range;
          if (!range) return cmd.insertText(s, text);
          const selection = clampSelection(s.doc, { anchor: range.from, focus: range.to });
          return cmd.insertText({ ...s, selection, storedMarks: null }, text);
        }),
      insertMarkdown: (markdown, options = {}) => {
        const fragment = parseMarkdown(markdown, this.markdown).blocks;
        const at = options.at;
        if (at instanceof WidgetImpl) {
          // After the widget's block, as blocks.
          if (at.isRemoved) return false;
          const block = getBlock(this.current.doc, at.blockId);
          return run((s) => cmd.insertFragment(s, fragment, { ...options, at: endOf(block), block: true }));
        }
        return run((s) => cmd.insertFragment(s, fragment, options as cmd.InsertOptions));
      },
      insertTable: (attrs = {}) => run((s) => cmd.insertBlock(s, { type: 'table', rows: attrs.rows, cols: attrs.cols })),
      insertDivider: () => run((s) => cmd.insertBlock(s, { type: 'divider' })),
      indent: () => run((s) => cmd.indentListItems(s, 1)),
      outdent: () => run((s) => cmd.indentListItems(s, -1)),
      undo: () => this.undo(),
      redo: () => this.redo(),
      selectAll: () => {
        this.setSelection(cmd.selectAll(this.current).selection);
        return true;
      },
      selectBlocks: () => {
        if (this.readOnly) return false;
        if (!this.hasFocus()) this.root.focus({ preventScroll: true });
        const { anchor, focus } = this.current.selection;
        this.selectBlockRange(anchor.blockId, focus.blockId);
        return true;
      },
      focus: (position) => {
        if (position !== undefined) {
          const blocks = this.current.doc.blocks;
          const pos =
            position === 'start' ? startOf(blocks[0]!) : position === 'end' ? endOf(blocks[blocks.length - 1]!) : position;
          this.current = { ...this.current, selection: clampSelection(this.current.doc, { anchor: pos, focus: pos }) };
        }
        this.focus();
        this.emit('selectionChange', { editor: this });
        return true;
      },
      blur: () => {
        const had = this.hasFocus();
        this.blur();
        return had;
      },
    };
  }

  private toggleMark(mark: Mark): boolean {
    return this.run((s) => cmd.toggleMark(s, mark));
  }

  private undo(): boolean {
    if (this.readOnly) return false;
    const next = this.history.undo(this.current);
    if (!next) return false;
    this.commit(next);
    return true;
  }

  private redo(): boolean {
    if (this.readOnly) return false;
    const next = this.history.redo(this.current);
    if (!next) return false;
    this.commit(next);
    return true;
  }

  // -------------------------------------------------------------------------
  // For the editor's own UI (toolbar, block handle)

  /** @internal Viewport rectangle of the selection, for positioning UI. */
  selectionRect(): DOMRect | null {
    const sel = this.root.ownerDocument.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects.length ? (isCollapsed(this.current.selection) ? rects[rects.length - 1]! : range.getBoundingClientRect()) : null;
    if (rect && (rect.width > 0 || rect.height > 0)) return rect;
    // An empty block has no text to measure.
    const el = this.renderer.elementFor(this.current.selection.focus.blockId);
    const content = el ? contentElement(el, this.current.selection.focus.cell) : null;
    return (content ?? el)?.getBoundingClientRect() ?? null;
  }

  /** @internal The rendered element of a block. */
  blockElement(id: string): HTMLElement | undefined {
    return this.renderer.elementFor(id);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.changeFrame !== null) cancelAnimationFrame(this.changeFrame);
    for (const fn of this.cleanup) fn();
    for (const { menu } of this.suggestions) menu.destroy();
    for (const widget of [...this.widgets]) widget.remove();
    this.blockMenu.destroy();
    this.toolbar?.destroy();
    this.linkPopover.destroy();
    this.handle.destroy();
    for (const name of Object.keys(this.runtime.attributes ?? {})) this.root.removeAttribute(name);
    for (const name of this.tokenNames) this.root.style.removeProperty(name);
    this.root.style.colorScheme = '';
    this.root.contentEditable = 'false';
    this.root.classList.remove('mbe-root');
    this.root.replaceChildren();
    this.listeners.clear();
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
    if (docChanged) this.relocateWidgets(this.current.doc, next.doc, false);
    this.current = next;
    if (this.blockSel) {
      // Block commands keep block IDs, so the same blocks stay selected.
      const range = this.blockRange();
      if (range) this.current = { ...next, selection: cmd.spanBlocks(next.doc.blocks, range) };
      else this.blockSel = null;
    }
    this.paint(false, false, hadFocus);
    this.afterRender();
    if (docChanged) this.scheduleChange();
    this.emit('selectionChange', { editor: this });
  }

  /** Emits a pending change now, so a submit or blur handler sees the latest Markdown. */
  private flushChange(): void {
    if (this.changeFrame === null) return;
    cancelAnimationFrame(this.changeFrame);
    this.changeFrame = null;
    this.emitChange();
  }

  private scheduleChange(): void {
    if (this.changeFrame !== null) return;
    if (!this.options.onChange && !this.listeners.get('change')?.size) return;
    const flush = () => {
      this.changeFrame = null;
      if (!this.destroyed) this.emitChange();
    };
    if (typeof requestAnimationFrame === 'function') this.changeFrame = requestAnimationFrame(flush);
    else flush();
  }

  private emitChange(): void {
    if (this.options.onChange) this.options.onChange(this.getMarkdown(), this);
    this.emit('change', { editor: this });
  }

  /**
   * Emits a pending change, then `submit` (Mod-Enter and Ctrl-Enter call
   * this). Returns false, doing nothing, when no one listens for submit.
   */
  submit(): boolean {
    if (!this.options.onSubmit && !this.listeners.get('submit')?.size) return false;
    this.flushChange();
    this.options.onSubmit?.(this.getMarkdown(), this);
    this.emit('submit', { editor: this });
    return true;
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
    const parked = this.parkedCaret();
    const target = parked ? { anchor: parked, focus: parked } : this.state.selection;
    const anchor = this.toDom(target.anchor);
    const focus = this.toDom(target.focus);
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
    if (target.focus.cell) {
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
    if (this.blockSel) {
      // Only the hidden caret moved: the browser may move it out of a block it
      // cannot hold a caret in (a divider). A click ends block selection on mousedown.
      this.updateUi();
      return;
    }
    const cur = this.state.selection;
    if (samePosition(selection.anchor, cur.anchor) && samePosition(selection.focus, cur.focus)) {
      this.updateUi();
      return;
    }
    this.current = { ...this.state, selection, storedMarks: null };
    this.history.breakGroup();
    if (!this.pointerDown) this.refreshRevealed();
    this.updateUi();
    this.emit('selectionChange', { editor: this });
  }

  /**
   * Renders the document, then puts the browser selection back. Only blocks
   * whose object or revealed views changed are rebuilt, unless `force`.
   * `hadFocus`: whether the editor had focus before the change (re-rendering
   * a table replaces the focused cell).
   */
  private paint(force = false, lazy = false, hadFocus = this.hasFocus()): void {
    const views = this.renderer.views;
    if (views && !this.pointerDown) this.renderer.revealed = revealedViews(this.state, views, !this.readOnly && hadFocus);
    this.renderer.render(this.state.doc, force, lazy);
    this.applyReadOnly();
    this.paintBlockSelection();
    this.syncDomSelection(hadFocus);
  }

  /** Re-renders if the views that show their source changed: after the selection, focus or editability changes. */
  private refreshRevealed(): void {
    const views = this.renderer.views;
    if (!views || this.pointerDown) return;
    const next = revealedViews(this.state, views, !this.readOnly && this.hasFocus());
    if (!sameRevealed(next, this.renderer.revealed)) this.paint();
  }

  private onMouseUp(): void {
    if (!this.pointerDown) return;
    this.pointerDown = false;
    if (!this.destroyed && !this.composing) this.refreshRevealed();
  }

  /**
   * When an arrow key at the edge of a block would move past a rendered raw
   * block next to it (the browser skips non-editable blocks), the position in
   * that block's source to move to instead.
   */
  private viewBlockPast(key: string): Position | null {
    const sel = this.state.selection;
    if (!isCollapsed(sel) || sel.focus.cell) return null;
    const pos = sel.focus;
    const blocks = this.state.doc.blocks;
    const index = blockIndex(this.state.doc, pos.blockId);
    const forward = key === 'ArrowDown' || key === 'ArrowRight';
    const next = blocks[index + (forward ? 1 : -1)];
    if (next?.type !== 'raw' || !this.renderer.elementFor(next.id)?.classList.contains('mbe-view-block')) return null;
    const current = blocks[index]!;
    if (!isTextBlock(current)) return null;
    if (key === 'ArrowRight' && pos.offset !== endOf(current).offset) return null;
    if (key === 'ArrowLeft' && pos.offset !== 0) return null;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      // Only from the first or last line of text.
      const caret = this.selectionRect();
      const box = contentElement(this.renderer.elementFor(current.id)!)?.getBoundingClientRect();
      if (caret && box && caret.height > 0 && (forward ? box.bottom - caret.bottom : caret.top - box.top) > caret.height / 2) return null;
    }
    return viewEntry(next, forward);
  }

  /** A click on a rendered view puts the caret in its source: at the end of a token, or of a block's formula. */
  private revealView(view: HTMLElement): void {
    const block = view.hasAttribute(BLOCK_ATTR) ? getBlock(this.state.doc, view.getAttribute(BLOCK_ATTR)!) : null;
    const pos = block ? (block.type === 'raw' ? viewEntry(block, false) : null) : domToPosition(this.root, view.parentNode!, childIndex(view) + 1);
    if (!pos) return;
    this.root.focus({ preventScroll: true });
    this.setSelection({ anchor: pos, focus: pos });
  }

  /** The browser selection is the source of truth when an event starts. */
  private refreshSelection(): void {
    // A block selection's browser selection is only a parked caret.
    if (this.blockSel) return;
    const selection = this.readDomSelection();
    if (selection) this.current = { ...this.state, selection };
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
    return e.target instanceof HTMLInputElement || !!(e.target as Element | null)?.closest?.('.mbe-widget');
  }

  private onBeforeInput(e: InputEvent): void {
    if (this.fromControl(e)) return;
    if (this.composing || e.isComposing) return;
    const type = e.inputType;
    if (type === 'insertCompositionText' || type === 'deleteCompositionText' || type === 'insertFromComposition') return;

    e.preventDefault();
    if (this.readOnly) return;
    if (this.blockSel) {
      // Typing does nothing while whole blocks are selected; deleting removes them.
      if (type.startsWith('delete')) this.deleteSelectedBlocks();
      else if (type === 'historyUndo') this.undo();
      else if (type === 'historyRedo') this.redo();
      return;
    }
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
    if (this.markdown.inline.length > 0) this.run((s) => cmd.applyTokenInputRules(s, this.markdown.inline) ?? s);
    if (text === ' ' && this.markdown.autolinks) this.run((s) => cmd.applyAutolinkInputRule(s) ?? s);
    if ([...text].length === 1) this.maybeOpenSuggestion(text);
  }

  private onCompositionStart(e: Event): void {
    if (this.fromControl(e)) return;
    this.dropBlockSelection();
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
      if (ch) this.maybeOpenSuggestion(ch);
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
      this.paint(true);
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
        if (menu !== this.blockMenu) this.closeSuggestion();
      }
      if (e.key === 'Escape') return handled(() => (menu !== this.blockMenu ? this.closeSuggestion() : this.closeBlockMenu()));
    }

    if (e.key === 'Escape' && this.toolbar?.isOpen) return handled(() => this.toolbar!.hide());
    if (this.readOnly) return;
    if (this.blockSel && this.onBlockKey(e)) {
      e.preventDefault();
      return;
    }

    // Extension key bindings, earlier extensions first.
    let refreshed = false;
    for (const binding of this.bindings) {
      if (!matchesKey(binding, e)) continue;
      if (!refreshed) this.refreshSelection();
      refreshed = true;
      if (binding.handler({ editor: this })) {
        e.preventDefault();
        return;
      }
    }

    if (mod && !e.altKey) {
      if (e.key === '/' && !e.shiftKey && this.hasBlockMenu(this.state.selection.focus.blockId)) {
        return handled(() => this.openBlockMenu(this.state.selection.focus.blockId));
      }
      if (key === 'v' && e.shiftKey) {
        // The paste event that follows inserts plain text.
        this.plainPasteNext = true;
        return;
      }
    }
    if (e.key.startsWith('Arrow') && !mod && !e.shiftKey && !e.altKey) {
      this.refreshSelection();
      // Step into the source of a rendered block, which the browser would skip.
      const into = this.renderer.views ? this.viewBlockPast(e.key) : null;
      if (into) {
        e.preventDefault();
        this.setSelection({ anchor: into, focus: into });
        return;
      }
      // On the last line of a final code block or table (or the first line of
      // a first one), add a paragraph past it. Elsewhere the browser moves the caret.
      const vertical = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      const next = vertical ? cmd.exitBlock(this.state, vertical) : this.state;
      if (next !== this.state) {
        e.preventDefault();
        this.run(() => next);
      }
    }
  }

  private moveMenu(menu: Menu, delta: number): void {
    menu.move(delta);
    this.syncActiveDescendant();
  }

  private onMouseDown(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    this.dropBlockSelection();
    if (target === this.root && e.button === 0 && !this.readOnly && this.clickBelowLastBlock(e)) return;
    const view = e.button === 0 && !this.readOnly ? target.closest?.<HTMLElement>('.mbe-view, .mbe-view-block') : null;
    if (view && this.root.contains(view)) {
      e.preventDefault();
      this.revealView(view);
      return;
    }
    if (e.button === 0) this.pointerDown = true;
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

  private onFocusIn(event: FocusEvent): void {
    if (this.focused || !this.hasFocus()) return;
    this.focused = true;
    this.root.classList.add('mbe-focused');
    // A click that focuses the editor reveals on mouseup, once its selection is known.
    if (!this.pointerDown) this.refreshRevealed();
    this.options.onFocus?.(this);
    this.emit('focus', { editor: this, event });
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
      this.refreshRevealed();
      this.hideUi();
      this.flushChange();
      this.options.onBlur?.(this);
      this.emit('blur', { editor: this, event: e });
    });
  }

  private onScroll(): void {
    this.handle.hide();
    if (this.suggest || this.toolbar?.isOpen || this.blockMenu.isOpen) this.updateUi();
  }

  // -------------------------------------------------------------------------
  // Clipboard

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (this.fromControl(e)) return;
    const range = this.blockRange();
    if (range) {
      // Whole blocks, even an empty one.
      if (!e.clipboardData) return;
      e.preventDefault();
      const doc: Doc = { blocks: this.state.doc.blocks.slice(range.from, range.to + 1).map(cmd.cloneBlock) };
      // serializeBlocks keeps a selected empty line, which serializeMarkdown drops at the end.
      writeClipboard(e.clipboardData, doc, serializeBlocks(doc.blocks, this.markdown));
      if (cut && !this.readOnly) this.deleteSelectedBlocks();
      return;
    }
    this.refreshSelection();
    if (isCollapsed(this.state.selection) || !e.clipboardData) return;
    e.preventDefault();
    const doc: Doc = { blocks: cmd.selectedBlocks(this.state) };
    writeClipboard(e.clipboardData, doc, serializeMarkdown(doc, this.markdown).replace(/\n$/, ''));
    if (cut && !this.readOnly) this.run(cmd.deleteSelection);
  }

  private onPaste(e: ClipboardEvent): void {
    if (this.fromControl(e)) return;
    e.preventDefault();
    if (this.readOnly) return;
    this.refreshSelection();
    for (const ext of this.extensions) if (ext.handlePaste?.({ editor: this, event: e })) return;
    const data = e.clipboardData;
    if (!data) return;
    const text = data.getData('text/plain');
    const html = data.getData('text/html');
    const plainOnly = this.plainPasteNext;
    this.plainPasteNext = false;

    // Over a block selection: the pasted blocks replace the selected ones.
    const range = this.blockRange();
    if (range) {
      const fragment = this.pastedBlocks(text, html, plainOnly);
      this.blockSel = null;
      this.run((s) => cmd.replaceBlocks(s, range, fragment));
      return;
    }
    const block = getBlock(this.state.doc, this.state.selection.focus.blockId);
    if (isPlainTextBlock(block)) {
      this.run((s) => cmd.insertText(s, text));
      return;
    }
    // A URL pasted over selected text makes it a link.
    const url = text.trim();
    if (!plainOnly && !isCollapsed(this.state.selection) && /^(https?:\/\/|mailto:)\S+$/i.test(url)) {
      this.run((s) => cmd.setLink(s, url));
      return;
    }
    const fragment = this.pastedBlocks(text, html, plainOnly);
    this.run((s) => cmd.insertBlocks(s, fragment));
  }

  /** Clipboard content as blocks: the editor's own Markdown, other HTML, or text as Markdown. */
  private pastedBlocks(text: string, html: string, plainOnly: boolean): readonly Block[] {
    // Mod+Shift+V: the text as typed, one paragraph per line.
    if (plainOnly) return text.replace(/\r\n?/g, '\n').split('\n').map((l) => paragraph(plain(l)));
    let fragment: readonly Block[];
    const internal = /data-mbe-markdown="([^"]*)"/.exec(html);
    if (internal) fragment = parseMarkdown(decodeURIComponent(internal[1]!), this.markdown).blocks;
    else if (html) fragment = htmlToDoc(html).blocks;
    else fragment = parseMarkdown(text, this.markdown).blocks;
    if (fragment.length === 0 && text) fragment = parseMarkdown(text, this.markdown).blocks;
    return fragment;
  }

  private onDrop(e: DragEvent): void {
    e.preventDefault();
    if (this.readOnly) return;
    const position = this.positionAtPoint(e.clientX, e.clientY);
    for (const ext of this.extensions) if (ext.handleDrop?.({ editor: this, event: e, position })) return;
    // Dropped text is inserted where it lands, like a paste there.
    const text = e.dataTransfer?.getData('text/plain');
    if (!text || !position) return;
    const fragment = parseMarkdown(text, this.markdown).blocks;
    this.focus();
    this.run((s) => cmd.insertFragment(s, fragment, { at: position }));
  }

  /** The document position at a viewport point, or null outside the editor's text. */
  positionAtPoint(x: number, y: number): Position | null {
    const doc = this.root.ownerDocument as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    let offset = 0;
    const caretPos = doc.caretPositionFromPoint?.(x, y);
    if (caretPos) {
      node = caretPos.offsetNode;
      offset = caretPos.offset;
    } else {
      const range = doc.caretRangeFromPoint?.(x, y);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    }
    if (!node || !this.root.contains(node)) return null;
    return domToPosition(this.root, node, offset);
  }

  // -------------------------------------------------------------------------
  // Suggestion menus (see extensions/suggestion.ts)

  /** Opens the suggestion menu whose trigger was just typed, if any. */
  private maybeOpenSuggestion(ch: string): void {
    const index = this.suggestions.findIndex(({ config }) => triggers(config).includes(ch));
    if (index < 0) return;
    const config = this.suggestions[index]!.config;
    const pos = this.current.selection.focus;
    const block = getBlock(this.current.doc, pos.blockId);
    if (!isTextBlock(block) || isPlainTextBlock(block) || pos.cell || !isCollapsed(this.current.selection)) return;
    const before = inlineText(block.content)[pos.offset - 2];
    // By default only at the start of a line or after a space, so URLs and paths do not open it.
    if (!config.allowAnywhere && before !== undefined && !/\s/.test(before)) return;
    this.closeSuggestion();
    this.suggest = { index, blockId: block.id, from: pos.offset - 1, request: 0 };
    this.updateUi();
  }

  private closeSuggestion(): void {
    if (this.suggest) this.suggestions[this.suggest.index]!.menu.hide();
    this.suggest = null;
    this.root.removeAttribute('aria-activedescendant');
    this.root.removeAttribute('aria-controls');
  }

  /** The text typed after the trigger, or null when the suggestion should close. */
  private suggestionQuery(): string | null {
    const active = this.suggest;
    if (!active || !isCollapsed(this.current.selection)) return null;
    const { config } = this.suggestions[active.index]!;
    const pos = this.current.selection.focus;
    if (pos.blockId !== active.blockId || pos.cell || pos.offset <= active.from) return null;
    const block = this.current.doc.blocks.find((b) => b.id === active.blockId);
    if (!block || !isTextBlock(block)) return null;
    const text = inlineText(block.content);
    if (!triggers(config).includes(text[active.from] ?? '')) return null;
    const query = text.slice(active.from + 1, pos.offset);
    if (query.includes('\n') || query.length > (config.maxLength ?? 30)) return null;
    if (config.allowSpaces ? /\s\s/.test(query) : /\s/.test(query)) return null;
    return query;
  }

  /** Asks for items when the query changed, and shows them when they arrive. */
  private refreshSuggestion(query: string): void {
    const active = this.suggest!;
    const { config, menu } = this.suggestions[active.index]!;
    if (active.query === query) {
      // Same query: only follow the caret. Rebuilding would reset the item the user moved to.
      if (menu.isOpen) this.placeSuggestion(menu);
      return;
    }
    active.query = query;
    const request = ++active.request;
    const result = config.items({ query, editor: this });
    const show = (items: readonly SuggestionItem[]) => {
      if (this.suggest !== active || active.request !== request || this.destroyed) return;
      if (items.length === 0 && (!config.emptyLabel || query.length > 3)) {
        menu.hide();
        this.syncActiveDescendant();
        return;
      }
      menu.setSections(
        [
          {
            items: items.map((item, i) => ({
              id: item.id ?? `${i}`,
              label: item.label,
              icon: item.icon,
              run: () => this.pickSuggestion(item),
            })),
          },
        ],
        config.emptyLabel,
      );
      this.placeSuggestion(menu);
    };
    if (isPromise(result)) result.then(show, () => undefined);
    else show(result);
  }

  private placeSuggestion(menu: Menu): void {
    const rect = this.selectionRect();
    if (rect) menu.popup.show(rect, 'below');
    this.root.setAttribute('aria-controls', menu.el.id);
    this.syncActiveDescendant();
  }

  private pickSuggestion(item: SuggestionItem): void {
    const active = this.suggest;
    if (!active) return;
    const { config } = this.suggestions[active.index]!;
    const query = active.query ?? '';
    const range = {
      from: { blockId: active.blockId, offset: active.from },
      to: { blockId: active.blockId, offset: active.from + 1 + query.length },
    };
    this.closeSuggestion();
    config.command({ editor: this, range, item, query });
  }

  /** The slash menu, as a suggestion. */
  private slashSuggestion(): SuggestionConfig<SlashItem> {
    const ids = this.options.slashMenu || SLASH_ITEM_IDS;
    const items: SlashItem[] = ids
      .map((id) => BLOCK_ITEMS.find((b) => b.id === id))
      .filter((b): b is BlockItem => !!b)
      .map((b) => ({ id: b.id, label: this.labels[b.id], icon: b.icon, aliases: b.aliases, spec: b.spec }));
    return {
      char: SLASH_CHARS,
      allowSpaces: true,
      emptyLabel: this.labels.noResults,
      className: 'mbe-slash-menu',
      items: ({ query }) => items.filter((item) => matches(item, query)),
      command: ({ range, item }) => {
        const blockId = range.from.blockId;
        const block = getBlock(this.current.doc, blockId);
        const text = isTextBlock(block) ? inlineText(block.content) : '';
        const end = range.to.offset;
        // At the end of a line, also drop the space typed before "/", so
        // "hello /h1" becomes a heading "hello", not "hello ".
        const from = end === text.length && text[range.from.offset - 1] === ' ' ? range.from.offset - 1 : range.from.offset;
        // Remove "/query", then convert or insert, as one undo step.
        this.run((s) => {
          const removed = cmd.deleteRange(s, { blockId, offset: from }, { blockId, offset: end });
          return cmd.insertBlock(removed, item.spec);
        });
      },
    };
  }

  // -------------------------------------------------------------------------
  // Block selection

  /** The blocks of the block selection, in document order. Empty when the selection is text. */
  get selectedBlocks(): readonly Block[] {
    const range = this.blockRange();
    return range ? this.current.doc.blocks.slice(range.from, range.to + 1) : [];
  }

  private blockRange(): cmd.BlockRange | null {
    if (!this.blockSel) return null;
    const doc = this.current.doc;
    const a = blockIndex(doc, this.blockSel.anchor);
    const h = blockIndex(doc, this.blockSel.head);
    return a < 0 || h < 0 ? null : { from: Math.min(a, h), to: Math.max(a, h) };
  }

  /** Selects whole blocks, from the block `anchor` to the block `head`. */
  private selectBlockRange(anchor: string, head: string): void {
    this.blockSel = { anchor, head };
    this.current = { ...this.current, selection: cmd.spanBlocks(this.current.doc.blocks, this.blockRange()!), storedMarks: null };
    this.history.breakGroup();
    this.closeSuggestion();
    this.toolbar?.hide();
    this.blockMenu.hide();
    this.refreshRevealed();
    this.paintBlockSelection();
    this.syncDomSelection(true);
    this.updateUi();
    this.emit('selectionChange', { editor: this });
  }

  /** Leaves block selection, keeping the hidden caret as a collapsed selection. */
  private dropBlockSelection(): void {
    const parked = this.parkedCaret();
    if (!parked) return;
    this.blockSel = null;
    this.current = { ...this.current, selection: { anchor: parked, focus: parked }, storedMarks: null };
    this.paintBlockSelection();
  }

  /** Leaves block selection with the caret at `pos`. */
  private exitBlockSelection(pos: Position): void {
    this.blockSel = null;
    this.paintBlockSelection();
    this.setSelection({ anchor: pos, focus: pos });
  }

  /** Where the hidden browser caret sits during a block selection: the start of the head block. */
  private parkedCaret(): Position | null {
    if (!this.blockSel) return null;
    const head = this.current.doc.blocks.find((b) => b.id === this.blockSel!.head);
    return head ? startOf(head) : null;
  }

  private paintBlockSelection(): void {
    const range = this.blockRange();
    const els: HTMLElement[] = [];
    if (range) {
      for (const block of this.current.doc.blocks.slice(range.from, range.to + 1)) {
        const el = this.renderer.elementFor(block.id);
        if (el) els.push(el);
      }
    }
    for (const el of this.selectedEls) if (!els.includes(el)) el.classList.remove('mbe-block-selected');
    for (const el of els) el.classList.add('mbe-block-selected');
    this.selectedEls = els;
    this.root.classList.toggle('mbe-block-selecting', els.length > 0);
  }

  private deleteSelectedBlocks(): void {
    const range = this.blockRange();
    if (!range) return;
    this.blockSel = null;
    this.run((s) => cmd.deleteBlocks(s, range));
  }

  /**
   * Keys while whole blocks are selected. Arrows move the selection by
   * block (Shift extends it), Enter and Left/Right go back to editing text,
   * Backspace and Delete remove the blocks, Mod+A selects every block,
   * Mod+D duplicates, and Escape leaves the editor. Other keys go to the
   * key bindings, which act on all selected blocks.
   */
  private onBlockKey(e: KeyboardEvent): boolean {
    const range = this.blockRange();
    if (!range) return false;
    const blocks = this.state.doc.blocks;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const clamp = (i: number) => blocks[Math.max(0, Math.min(blocks.length - 1, i))]!.id;
    switch (e.key) {
      case 'Escape':
        if (!plain || e.shiftKey) return false;
        this.dropBlockSelection();
        this.blur();
        return true;
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!plain) return false;
        const up = e.key === 'ArrowUp';
        if (e.shiftKey) {
          this.selectBlockRange(this.blockSel!.anchor, clamp(blockIndex(this.current.doc, this.blockSel!.head) + (up ? -1 : 1)));
        } else {
          const id = clamp(up ? range.from - 1 : range.to + 1);
          this.selectBlockRange(id, id);
        }
        return true;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
        if (!plain || e.shiftKey) return false;
        this.exitBlockSelection(e.key === 'ArrowLeft' ? startOf(blocks[range.from]!) : endOf(blocks[range.to]!));
        return true;
      case 'Enter':
        if (!plain || e.shiftKey) return false;
        this.exitBlockSelection(endOf(blocks[range.to]!));
        return true;
      case 'Backspace':
      case 'Delete':
        if (!plain) return false;
        this.deleteSelectedBlocks();
        return true;
    }
    if (mod && !e.altKey && !e.shiftKey) {
      const key = e.key.toLowerCase();
      if (key === 'a') {
        this.selectBlockRange(blocks[0]!.id, blocks[blocks.length - 1]!.id);
        return true;
      }
      if (key === 'd') {
        const count = range.to - range.from + 1;
        if (this.run((s) => cmd.duplicateBlocks(s, range))) {
          const copies = this.current.doc.blocks;
          this.selectBlockRange(copies[range.to + 1]!.id, copies[range.to + count]!.id);
        }
        return true;
      }
    }
    return false;
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
    this.dropBlockSelection();
    this.closeSuggestion();
    this.toolbar?.hide();
    // Keep the caret in the table cell for table actions; otherwise move it into the block.
    if (this.state.selection.focus.blockId !== blockId) {
      const block = getBlock(this.state.doc, blockId);
      const start = startOf(block);
      this.current = { ...this.state, selection: { anchor: start, focus: start } };
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

  openLinkPopover(): void {
    if (this.readOnly) return;
    const block = getBlock(this.state.doc, this.state.selection.focus.blockId);
    if (isPlainTextBlock(block)) return;
    if (isCollapsed(this.state.selection) && !cmd.activeLink(this.state)) return;
    const rect = this.selectionRect();
    if (!rect) return;
    this.toolbar?.hide();
    const saved = this.state.selection;
    this.linkPopover.open(rect, cmd.activeLink(this.current)?.href ?? '', (href) => {
      this.current = { ...this.state, selection: saved };
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
    const el = focused && !this.blockSel && isCollapsed(this.state.selection) ? this.renderer.elementFor(pos.blockId) : undefined;
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

    // Suggestion menu.
    const query = focused && !this.composing ? this.suggestionQuery() : null;
    if (query === null) {
      if (this.suggest) this.closeSuggestion();
    } else {
      this.refreshSuggestion(query);
    }

    // Formatting toolbar.
    if (this.toolbar) {
      const block = this.state.doc.blocks.find((b) => b.id === pos.blockId);
      const show =
        focused &&
        !this.readOnly &&
        !this.composing &&
        !isCollapsed(this.state.selection) &&
        !this.blockSel &&
        !this.suggest &&
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
    const suggestion = this.suggest ? this.suggestions[this.suggest.index]!.menu : null;
    return suggestion?.isOpen ? suggestion : this.blockMenu.isOpen ? this.blockMenu : null;
  }

  private syncActiveDescendant(): void {
    const id = this.openMenu()?.activeDescendant;
    if (id) this.root.setAttribute('aria-activedescendant', id);
    else this.root.removeAttribute('aria-activedescendant');
  }

  private hideUi(): void {
    this.dropBlockSelection();
    this.closeSuggestion();
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

/** The `isActive` name of a block's type. */
function blockName(block: Block): ActiveName {
  switch (block.type) {
    case 'listItem':
      return block.listType === 'bullet' ? 'bulletList' : block.listType === 'ordered' ? 'orderedList' : 'taskList';
    case 'quote':
      return 'blockquote';
    case 'code':
      return 'codeBlock';
    default:
      return block.type;
  }
}

/** Writes blocks to the clipboard as Markdown and as HTML that carries the Markdown, so pasting into an editor is lossless. */
function writeClipboard(data: DataTransfer, doc: Doc, text: string): void {
  data.setData('text/plain', text);
  data.setData('text/html', `<meta charset="utf-8"><div data-mbe-markdown="${encodeURIComponent(text)}">${docToHtml(doc)}</div>`);
}

function sameBlocks(a: Doc, b: Doc): boolean {
  return a.blocks.length === b.blocks.length && a.blocks.every((block, i) => block === b.blocks[i]);
}

function isSelection(value: Selection | SelectionJSON): value is Selection {
  return typeof (value as Selection).anchor?.blockId === 'string';
}

/** Reads a SelectionJSON, clamping it to the document. Returns null for anything that is not one. */
function selectionFromJSON(doc: Doc, value: unknown): Selection | null {
  const read = (p: unknown): Position | null => {
    if (!p || typeof p !== 'object') return null;
    const { block, offset, cell } = p as Record<string, unknown>;
    if (!Number.isInteger(block) || !Number.isInteger(offset)) return null;
    const index = Math.max(0, Math.min(block as number, doc.blocks.length - 1));
    const target = doc.blocks[index]!;
    if ((block as number) >= doc.blocks.length) return endOf(target);
    if (target.type === 'table') {
      const c = cell && typeof cell === 'object' ? (cell as Record<string, unknown>) : {};
      const row = Number.isInteger(c.row) ? Math.max(0, Math.min(c.row as number, target.rows.length - 1)) : 0;
      const col = Number.isInteger(c.col) ? Math.max(0, Math.min(c.col as number, target.rows[0]!.length - 1)) : 0;
      return { blockId: target.id, offset: Math.max(0, offset as number), cell: { row, col } };
    }
    return { blockId: target.id, offset: Math.max(0, offset as number) };
  };
  if (!value || typeof value !== 'object') return null;
  const anchor = read((value as Record<string, unknown>).anchor);
  const focus = read((value as Record<string, unknown>).focus);
  if (!anchor || !focus) return null;
  return clampSelection(doc, { anchor, focus });
}

function triggers(config: SuggestionConfig): readonly string[] {
  return typeof config.char === 'string' ? [config.char] : config.char;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function';
}
