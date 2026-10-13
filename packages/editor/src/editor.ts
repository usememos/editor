// The editor view: one contentEditable root that the editor fully owns.
//
// Input strategy ("model first, DOM fallback"):
// 1. Most edits arrive as `beforeinput` events. We cancel them, apply the
//    matching command to the model, and re-render the changed blocks.
// 2. IME composition cannot be cancelled. During composition the browser
//    edits the DOM itself and we do not touch it. On each `input` we read the
//    composed block's text back into the model without re-rendering it, so
//    `change` and `getMarkdown` keep up (on Android every word is a
//    composition). On `compositionend` the block is rendered from the model.
// 3. Any other `input` that slipped through (input that cannot be cancelled,
//    e.g. from some Android keyboards) is read back the same way.

import * as cmd from './commands';
import { docToHtml } from './clipboard/toHtml';
import { htmlToDoc } from './clipboard/fromHtml';
import { type ChangeKind, History } from './history';
import { DEFAULT_LABELS, type Labels } from './labels';
import { type Icon, type IconName, type Icons, builtinIcon } from './icons';
import { parseMarkdown } from './markdown/parse';
import { serializeBlocks, serializeMarkdown } from './markdown/serialize';
import { type MarkdownSource, loadMarkdown } from './markdown/source';
import { type MarkdownOptions, type ResolvedMarkdown, resolveMarkdown } from './markdown/options';
import type { Extension } from './extension';
import { defaultKeymap } from './extensions/keymap';
import { decorationContext } from './decorations';
import type { SuggestionConfig, SuggestionItem } from './extensions/suggestion';
import { SuggestionController, type SuggestionState } from './suggest/controller';
import { type Widget, WidgetImpl, type WidgetRender } from './widgets';
import { type Binding, matchesKey, parseKeyName } from './keymap';
import {
  type Block,
  type Doc,
  type EditorState,
  type HeadingLevel,
  type Mark,
  type Position,
  type RawBlock,
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
import { Menu, type MenuSection, isMac, isSafari, isTouch, matches, setPopupContainer } from './ui/popup';
import { BLOCK_ATTR, BlockRenderer, childIndex, contentElement, domText, domToPosition, positionToDom, safeHref } from './view/dom';
import { revealedViews, sameRevealed, viewEntry } from './view/reveal';
import { scrollRectIntoView } from './view/scroll';
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
  /** While `editable` is false, lets the user tick and untick task items. Default false. */
  taskToggle?: boolean;
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
  /** Replaces built-in icons, by the `labels` key of the same control. A string is shown as text; an element is cloned. */
  icons?: Icons;
  /** Shows the formatting toolbar on selection. Default true. */
  toolbar?: boolean;
  /**
   * The element menus, the toolbar and other popups are appended to.
   * Default: the nearest open `<dialog>` or `aria-modal` ancestor of
   * `element`, else `document.body`.
   */
  popupContainer?: HTMLElement;
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
export type RuntimeOptions = Pick<EditorOptions, 'placeholder' | 'editable' | 'taskToggle' | 'attributes' | 'resolveImageSrc' | 'theme' | 'extensions'>;

export interface EditorEvents {
  /** After document changes, at most once per animation frame. */
  change: { editor: Editor };
  /** The selection moved or the document changed. */
  selectionChange: { editor: Editor };
  focus: { editor: Editor; event: FocusEvent };
  blur: { editor: Editor; event: FocusEvent };
  /** Mod-Enter or Ctrl-Enter. */
  submit: { editor: Editor };
  /** The autocomplete popup opened, closed, or changed its query, items, highlight or loading state. */
  suggestionChange: { editor: Editor; state: SuggestionState | null };
}

export interface SuggestionApi {
  /** The open suggestion: its query, range, items and highlighted item. Null when none is open. */
  readonly state: SuggestionState | null;
  /**
   * Opens the popup for the token at the caret, as Ctrl+Space does, even
   * where typing would not open it. With `name`, only that suggestion.
   * Returns false when there is no token at the caret.
   */
  open(name?: string): boolean;
  /** Closes the popup and keeps it closed for this token, as Escape does. */
  close(): void;
  /** Moves the highlight by `delta` items, wrapping around, as the arrow keys do. */
  move(delta: number): void;
  /** Picks the item at `index`, or the highlighted one, as Enter does. Returns false when there is none. */
  accept(index?: number): boolean;
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
  /** Scrolls the caret (the selection's focus end) into view, in scrolling containers and the window. */
  scrollIntoView(): boolean;
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
  aliases: string[];
  spec: cmd.BlockTypeSpec;
}

/** Block types for the slash menu. Each label is `labels[id]`. */
const BLOCK_ITEMS: readonly BlockItem[] = [
  { id: 'text', aliases: ['paragraph', 'plain'], spec: { type: 'paragraph' } },
  { id: 'heading1', aliases: ['h1', 'title'], spec: { type: 'heading', level: 1 } },
  { id: 'heading2', aliases: ['h2', 'subtitle'], spec: { type: 'heading', level: 2 } },
  { id: 'heading3', aliases: ['h3'], spec: { type: 'heading', level: 3 } },
  { id: 'bulletList', aliases: ['ul', 'unordered', 'bullet'], spec: { type: 'listItem', listType: 'bullet' } },
  { id: 'numberedList', aliases: ['ol', 'ordered'], spec: { type: 'listItem', listType: 'ordered' } },
  { id: 'todoList', aliases: ['task', 'checkbox', 'checklist'], spec: { type: 'listItem', listType: 'task' } },
  { id: 'quote', aliases: ['blockquote', 'citation'], spec: { type: 'quote' } },
  { id: 'code', aliases: ['pre', 'snippet', 'fence'], spec: { type: 'code' } },
  { id: 'table', aliases: ['grid'], spec: { type: 'table' } },
  { id: 'divider', aliases: ['hr', 'separator', 'line', 'rule'], spec: { type: 'divider' } },
];

/** Block menu actions for the table cell with the caret. Each label is `labels[id]`. */
const TABLE_ITEMS: readonly { id: IconName; action: cmd.TableAction }[] = [
  { id: 'addRowAbove', action: { kind: 'addRowAbove' } },
  { id: 'addRowBelow', action: { kind: 'addRowBelow' } },
  { id: 'addColumnLeft', action: { kind: 'addColumnLeft' } },
  { id: 'addColumnRight', action: { kind: 'addColumnRight' } },
  { id: 'alignLeft', action: { kind: 'align', align: 'left' } },
  { id: 'alignCenter', action: { kind: 'align', align: 'center' } },
  { id: 'alignRight', action: { kind: 'align', align: 'right' } },
  { id: 'deleteRow', action: { kind: 'deleteRow' } },
  { id: 'deleteColumn', action: { kind: 'deleteColumn' } },
];

const SLASH_CHARS = ['/', '／'];

/** Keys that move the caret, which the browser handles unless the editor does. */
const CARET_KEY = /^(Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/;

/** Input types of IME composition. The browser applies them; `input` reads them back. */
const COMPOSITION_INPUT = new Set(['insertCompositionText', 'deleteCompositionText', 'insertFromComposition', 'deleteByComposition']);

interface SlashItem extends SuggestionItem {
  readonly id: SlashItemId;
  readonly aliases: string[];
  readonly spec: cmd.BlockTypeSpec;
}

export class Editor {
  /** The editable element the editor renders into: `options.element`, or for `useEditor`, the element `<EditorContent>` mounts. */
  readonly root: HTMLElement;
  /** @internal The UI strings: the defaults with the `labels` option applied. */
  readonly labels: Labels;
  readonly commands: EditorCommands;
  /** The autocomplete popup of `suggestion()` extensions and the slash menu. */
  readonly suggestion: SuggestionApi;
  private current: EditorState;
  /** The Markdown the document was loaded from; unchanged blocks are saved as this text. */
  private source: MarkdownSource;
  /** The Markdown dialect: options plus the syntax of extensions. */
  private readonly markdown: ResolvedMarkdown;
  private readonly history = new History();
  private readonly renderer: BlockRenderer;
  private composing = false;
  /**
   * The current composition, kept until its block is rendered again: its
   * block, the marks for composed text, and whether it has an undo step yet.
   */
  private composition: { blockId: string; marks: EditorState['storedMarks']; recorded: boolean } | null = null;
  /** When the last composition ended (Safari only): the next key may be the Enter that committed it. */
  private compositionEndedAt = 0;
  /** Blocks the browser edited during a composition that ended, rendered again on the next frame. */
  private readonly unsettled = new Set<string>();
  private settleFrame: number | null = null;
  private readOnly: boolean;
  private wasReadOnly = false;
  /** Task checkboxes stay usable while read-only. */
  private taskToggle: boolean;
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
  /** The selection the formatting toolbar was closed for with Escape. It stays closed until the selection changes. */
  private toolbarClosedFor: Selection | null = null;
  /** Handling a key press, typed text, a paste or a drop: changes then scroll the caret into view. */
  private typing = 0;
  /**
   * A caret key the browser is handling: the block the caret was in, the
   * caret's x, and 1 or -1 for a plain ArrowDown or ArrowUp. The next
   * selection change checks where the caret went (see `onSelectionChange`).
   */
  private caretKey: { from: number; x: number; vertical: 0 | 1 | -1 } | null = null;

  /** Suggestion menus from extensions, then the slash menu (see suggest/controller.ts). */
  private readonly suggestions: SuggestionController;
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
    this.taskToggle = options.taskToggle === true;
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

    setPopupContainer(root, options.popupContainer);
    const configs = this.extensions.flatMap((e) => (e.suggestion ? [e.suggestion] : []));
    if (options.slashMenu !== false) configs.push(this.slashSuggestion() as unknown as SuggestionConfig);
    this.suggestions = new SuggestionController(
      {
        editor: this,
        root,
        syncActiveDescendant: () => this.syncActiveDescendant(),
        refresh: () => this.updateUi(),
        endComposition: () => this.endComposition(),
        changed: (state) => this.emit('suggestionChange', { editor: this, state }),
      },
      configs,
    );
    const suggestions = this.suggestions;
    this.suggestion = {
      get state() {
        return suggestions.state;
      },
      open: (name) => !this.destroyed && (this.refreshSelection(), suggestions.open(name)),
      close: () => suggestions.dismiss(),
      move: (delta) => suggestions.move(delta),
      accept: (index) => !this.destroyed && suggestions.accept(index),
    };
    this.blockMenu = new Menu(root, 'mbe-block-menu', 'menu');
    this.blockMenu.onPicked = () => this.blockMenu.hide();
    this.linkPopover = new LinkPopover(this);
    this.toolbar = options.toolbar === false ? null : new FormatToolbar(this);
    this.handle = new BlockHandle(this);

    this.listen(root, 'beforeinput', this.typed((e) => this.onBeforeInput(e as InputEvent)));
    this.listen(root, 'input', this.typed((e) => this.onInput(e as InputEvent)));
    this.listen(root, 'compositionstart', (e) => this.onCompositionStart(e));
    this.listen(root, 'compositionend', this.typed((e) => this.onCompositionEnd(e)));
    this.listen(root, 'keydown', this.typed((e) => this.onKeyDown(e as KeyboardEvent)));
    this.listen(root, 'copy', (e) => this.onCopy(e as ClipboardEvent, false));
    this.listen(root, 'cut', this.typed((e) => this.onCopy(e as ClipboardEvent, true)));
    this.listen(root, 'paste', this.typed((e) => this.onPaste(e as ClipboardEvent)));
    this.listen(root, 'dragstart', (e) => e.preventDefault());
    this.listen(root, 'dragover', (e) => {
      if (!this.readOnly) e.preventDefault();
    });
    this.listen(root, 'drop', this.typed((e) => this.onDrop(e as DragEvent)));
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
    if (this.destroyed) return;
    if (options.history === 'keep') this.history.record(this.current, 'other');
    else this.history.clear();
    const loaded = loadMarkdown(markdown, this.markdown);
    this.source = loaded.source;
    this.blockSel = null;
    this.suggestions.reset();
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
    return !this.readOnly && !this.destroyed;
  }

  /** True after `destroy()`. The editor then ignores every call that would change it; `getMarkdown()` still returns its last Markdown. */
  get isDestroyed(): boolean {
    return this.destroyed;
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
    if (this.destroyed) return false;
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
    if (this.destroyed) {
      // A widget that was never shown, so a late upload's code can still call it.
      const widget = new WidgetImpl(this.root.ownerDocument.createElement('div'), '', () => {}, () => {});
      widget.remove();
      return widget;
    }
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
    if (this.destroyed) return;
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

  /**
   * Changes `placeholder`, `editable`, `taskToggle`, `attributes`,
   * `resolveImageSrc` or `theme`. `extensions` only updates the callbacks of
   * `suggestion()` extensions (`items`, `command`, `match`, `allow`), matched
   * by name; other changes to extensions need a new editor.
   */
  setOptions(options: RuntimeOptions): void {
    if (this.destroyed) return;
    if (options.extensions) this.suggestions.setConfigs(options.extensions.flatMap((e) => (e.suggestion ? [e.suggestion] : [])));
    const toggle = options.taskToggle !== undefined && options.taskToggle !== this.taskToggle;
    if (toggle) this.taskToggle = options.taskToggle === true;
    if (options.editable !== undefined && options.editable === this.readOnly) {
      this.readOnly = !options.editable;
      this.refreshRevealed();
      this.applyReadOnly();
      this.hideUi();
    } else if (toggle) {
      this.applyReadOnly();
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
    if (this.readOnly || this.destroyed) return false;
    let next = command(this.current);
    if (!next || next === this.current) return false;
    next = cmd.dropBrokenTokens(next, this.current, this.markdown.inline);
    next = cmd.clampListIndents(next, this.current);
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
    const commands: EditorCommands = {
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
      scrollIntoView: () => {
        const rect = this.caretRect();
        if (!rect) return false;
        scrollRectIntoView(this.root, rect);
        return true;
      },
    };
    // After destroy every command does nothing, so late callbacks (an upload
    // that finishes after the editor closed) cannot render into the element.
    for (const name of Object.keys(commands) as (keyof EditorCommands)[]) {
      const fn = commands[name] as (...args: unknown[]) => boolean;
      (commands as unknown as Record<string, (...args: unknown[]) => boolean>)[name] = (...args) => !this.destroyed && fn(...args);
    }
    return commands;
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

  /** @internal The caret at the model's selection focus. Unlike `selectionRect`, works while the editor is not focused. */
  caretRect(): DOMRect | null {
    const pos = this.current.selection.focus;
    const point = this.toDom(pos);
    if (point) {
      const range = this.root.ownerDocument.createRange();
      range.setStart(point.node, point.offset);
      const rects = range.getClientRects();
      const rect = rects[rects.length - 1];
      if (rect && rect.height > 0) return rect;
    }
    // An empty block, or a caret next to an atom, has no text to measure.
    const el = this.renderer.elementFor(pos.blockId);
    return ((el && contentElement(el, pos.cell)) ?? el)?.getBoundingClientRect() ?? null;
  }

  /** @internal The viewport rectangle of the text from `from` to `to` in one block or cell (its first line), and whether that text is right-to-left. */
  textRect(from: Position, to: Position): { rect: DOMRect; rtl: boolean } | null {
    const start = this.toDom(from);
    const end = this.toDom(to);
    if (!start || !end) return null;
    const range = this.root.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const rect = range.getClientRects()[0];
    if (!rect) return null;
    const el = start.node.nodeType === 1 ? (start.node as Element) : start.node.parentElement;
    const rtl = !!el && this.root.ownerDocument.defaultView!.getComputedStyle(el).direction === 'rtl';
    return { rect, rtl };
  }

  /** Scrolls the editor and the elements around it so the caret is visible. */
  private scrollCaretIntoView(): void {
    const rect = this.caretRect();
    if (rect) scrollRectIntoView(this.root, rect);
  }

  /** @internal The rendered element of a block. */
  blockElement(id: string): HTMLElement | undefined {
    return this.renderer.elementFor(id);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.changeFrame !== null) cancelAnimationFrame(this.changeFrame);
    if (this.settleFrame !== null) cancelAnimationFrame(this.settleFrame);
    for (const fn of this.cleanup) fn();
    this.suggestions.destroy();
    for (const widget of [...this.widgets]) widget.remove();
    this.blockMenu.destroy();
    this.toolbar?.destroy();
    this.linkPopover.destroy();
    this.handle.destroy();
    setPopupContainer(this.root, undefined);
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
    const moved = next.selection !== this.state.selection;
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
    // Typing at the bottom of a scrolled editor keeps the caret in view. A
    // change from code does not scroll; the app calls commands.scrollIntoView.
    if (moved && hadFocus && this.typing > 0) this.scrollCaretIntoView();
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
    if (this.destroyed) return false;
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
    const ticking = this.ticking;
    this.root.classList.toggle('mbe-readonly', this.readOnly);
    this.root.classList.toggle('mbe-tasks', ticking);
    this.root.setAttribute('aria-readonly', String(this.readOnly));
    this.root.querySelectorAll<HTMLElement>('[data-row]').forEach((cell) => {
      cell.contentEditable = this.readOnly ? 'false' : 'true';
    });
    this.root.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      const box = input.classList.contains('mbe-checkbox');
      input.disabled = this.readOnly && !(box && ticking);
      if (!box) return;
      input.tabIndex = ticking ? 0 : -1;
      if (ticking) input.setAttribute('aria-label', taskName(input, this.labels.task));
      else input.removeAttribute('aria-label');
    });
  }

  /** True while read-only with task toggling on: only task checkboxes respond. */
  private get ticking(): boolean {
    return this.readOnly && this.taskToggle;
  }

  /** Toggles a task item from its checkbox, while editing or while read-only with `taskToggle`. */
  private toggleTaskAt(box: HTMLElement): void {
    const blockEl = box.closest<HTMLElement>('[data-block-id]');
    if (!blockEl) return;
    const id = blockEl.dataset.blockId!;
    const focused = box === this.root.ownerDocument.activeElement;
    if (!this.readOnly) this.run((s) => cmd.toggleTask(s, id));
    else if (this.ticking && this.current.doc.blocks.some((b) => b.id === id)) this.apply(cmd.toggleTask(this.current, id), 'other');
    else return;
    // The item re-renders with a new checkbox; keep keyboard focus on it.
    if (focused) this.root.querySelector<HTMLElement>(`[data-block-id="${id}"] .mbe-checkbox`)?.focus({ preventScroll: true });
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
    const key = this.caretKey;
    this.caretKey = null;
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
    const skipped = key?.vertical ? this.skippedBlock(key.from, key.vertical, key.x, selection.focus) : null;
    if (skipped) {
      this.setSelection({ anchor: skipped, focus: skipped });
    } else {
      this.current = { ...this.state, selection, storedMarks: null };
      this.history.breakGroup();
      if (!this.pointerDown) this.refreshRevealed();
      this.updateUi();
      this.emit('selectionChange', { editor: this });
    }
    // Browsers scroll the caret into view, but not always clear of the editor's edge.
    if (key) this.scrollCaretIntoView();
  }

  /**
   * After the browser moved the caret from block `from` with ArrowDown
   * (`dir` 1) or ArrowUp to `to`: the position in the first block it passed
   * over that holds a caret, at `x`. Firefox passes over list items (they are
   * flex boxes), WebKit over code blocks and tables. Null when no block was
   * passed over.
   */
  private skippedBlock(from: number, dir: 1 | -1, x: number, to: Position): Position | null {
    const blocks = this.state.doc.blocks;
    const end = blockIndex(this.state.doc, to.blockId);
    for (let i = from + dir; (end - i) * dir > 0; i += dir) {
      const block = blocks[i]!;
      if (block.type !== 'divider') return this.blockEntry(block, dir === 1, x);
    }
    return null;
  }

  /** Where the caret goes moving into `block` from above (`forward`) or below: its first or last line, at `x`. */
  private blockEntry(block: Block, forward: boolean, x: number): Position {
    const el = this.renderer.elementFor(block.id);
    if (block.type === 'raw' && el?.classList.contains('mbe-view-block')) return viewEntry(block, forward);
    if (el) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(contentElement(el) ?? el);
      const lines = Array.from(range.getClientRects()).filter((r) => r.height > 0);
      const line = forward ? lines[0] : lines[lines.length - 1];
      const pos = line ? this.positionAtPoint(x, line.top + line.height / 2) : null;
      if (pos?.blockId === block.id) return pos;
    }
    if (block.type === 'table') {
      const row = forward ? 0 : block.rows.length - 1;
      return { blockId: block.id, offset: forward ? 0 : inlineLength(block.rows[row]![0]!), cell: { row, col: 0 } };
    }
    return forward ? startOf(block) : endOf(block);
  }

  /**
   * Renders the document, then puts the browser selection back. Only blocks
   * whose object or revealed views changed are rebuilt, unless `force`.
   * `hadFocus`: whether the editor had focus before the change (re-rendering
   * a table replaces the focused cell).
   */
  private paint(force = false, lazy = false, hadFocus = this.hasFocus()): void {
    const views = this.renderer.views;
    if (views && !this.pointerDown && !this.composing) this.renderer.revealed = revealedViews(this.state, views, !this.readOnly && hadFocus);
    this.renderer.render(this.state.doc, force, lazy);
    this.applyReadOnly();
    this.paintBlockSelection();
    // Moving the browser selection would end the composition.
    if (!this.composing) this.syncDomSelection(hadFocus);
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
   * block or a table next to it, the position inside that block to move to
   * instead: the browser skips non-editable blocks, and sometimes a table
   * (its cells are separate editing hosts). A table is entered in its first
   * column.
   */
  private blockPast(key: string): Position | null {
    const sel = this.state.selection;
    if (!isCollapsed(sel) || sel.focus.cell) return null;
    const pos = sel.focus;
    const blocks = this.state.doc.blocks;
    const index = blockIndex(this.state.doc, pos.blockId);
    const forward = key === 'ArrowDown' || key === 'ArrowRight';
    const next = blocks[index + (forward ? 1 : -1)];
    const view = next?.type === 'raw' && this.renderer.elementFor(next.id)?.classList.contains('mbe-view-block');
    if (!next || (!view && next.type !== 'table')) return null;
    const current = blocks[index]!;
    if (!isTextBlock(current)) return null;
    if (key === 'ArrowRight' && pos.offset !== endOf(current).offset) return null;
    if (key === 'ArrowLeft' && pos.offset !== 0) return null;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      // Only from the first or last line of text.
      const content = contentElement(this.renderer.elementFor(current.id)!);
      if (content && !this.onEdgeLine(content, forward)) return null;
    }
    if (next.type === 'table') {
      const row = forward ? 0 : next.rows.length - 1;
      return { blockId: next.id, offset: forward ? 0 : inlineLength(next.rows[row]![0]!), cell: { row, col: 0 } };
    }
    return viewEntry(next as RawBlock, forward);
  }

  /**
   * ArrowUp or ArrowDown on the first or last line of a table cell: the
   * position in the cell above or below (same column), or past the table in
   * the next block that holds a caret. Null when the caret is not on that
   * line, or when the table ends the document that way (`exitBlock` adds a
   * paragraph there).
   */
  private tableCellPast(dir: 1 | -1): Position | null {
    const sel = this.state.selection;
    const pos = sel.focus;
    if (!isCollapsed(sel) || !pos.cell) return null;
    const blocks = this.state.doc.blocks;
    const index = blockIndex(this.state.doc, pos.blockId);
    const table = blocks[index];
    if (table?.type !== 'table') return null;
    const content = contentElement(this.renderer.elementFor(table.id)!, pos.cell);
    if (content && !this.onEdgeLine(content, dir === 1)) return null;
    const { row, col } = pos.cell;
    const target = table.rows[row + dir];
    if (target) {
      const offset = Math.min(pos.offset, inlineLength(target[col]!));
      return { blockId: table.id, offset, cell: { row: row + dir, col } };
    }
    for (let i = index + dir; i >= 0 && i < blocks.length; i += dir) {
      const next = blocks[i]!;
      if (next.type === 'divider') continue;
      if (next.type === 'table') {
        const r = dir === 1 ? 0 : next.rows.length - 1;
        const c = Math.min(col, next.align.length - 1);
        return { blockId: next.id, offset: dir === 1 ? 0 : inlineLength(next.rows[r]![c]!), cell: { row: r, col: c } };
      }
      if (next.type === 'raw' && this.renderer.elementFor(next.id)?.classList.contains('mbe-view-block')) return viewEntry(next, dir === 1);
      return dir === 1 ? startOf(next) : endOf(next);
    }
    return null;
  }

  /**
   * Whether the caret is on the last (`forward`) or first line of the text in
   * `content`. Lines are measured from the text, not the element's box, which
   * has padding (a table cell) and may be taller than its text.
   */
  private onEdgeLine(content: HTMLElement, forward: boolean): boolean {
    const caret = this.selectionRect();
    if (!caret || caret.height === 0) return true;
    const range = content.ownerDocument.createRange();
    range.selectNodeContents(content);
    const lines = Array.from(range.getClientRects()).filter((r) => r.height > 0);
    if (lines.length === 0) return true;
    const half = caret.height / 2;
    return forward
      ? Math.max(...lines.map((r) => r.bottom)) - caret.bottom <= half
      : caret.top - Math.min(...lines.map((r) => r.top)) <= half;
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
    if (COMPOSITION_INPUT.has(type)) return;
    // Input that cannot be cancelled (from some Android keyboards) changes the
    // DOM anyway, and `input` reads it back. Applying it here too would apply it twice.
    if (!e.cancelable && this.browserApplies(e)) return;

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
        // Mobile autocorrect and word suggestions replace the word before the
        // caret: the target range covers it while the selection is a caret.
        const range = isCollapsed(this.state.selection) ? this.targetRange(e) : null;
        if (range && !isCollapsed(range)) this.current = { ...this.state, selection: range };
        if (text) this.typeText(text);
        else if (range && !isCollapsed(range)) this.run(cmd.deleteSelection, 'typing');
        return;
      }
      case 'insertReplacementText': {
        const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? '';
        const range = this.targetRange(e);
        this.run((s) => cmd.insertText(range ? { ...s, selection: range } : s, text));
        return;
      }
      case 'insertParagraph': {
        // Android keyboards send Enter as keyCode 229, which keydown ignores,
        // so an open suggestion popup takes it here.
        if (this.suggestions.isOpen && this.suggestions.accept()) return;
        this.run(cmd.splitBlock);
        return;
      }
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
    this.afterTyping(text);
  }

  /**
   * True for input the `input` handler can read back from the DOM: text typed
   * or replaced, and deletions inside one text container. Other changes (a new
   * block, a deletion that joins blocks) are applied to the model instead.
   */
  private browserApplies(e: InputEvent): boolean {
    const type = e.inputType;
    if (type === 'insertText' || type === 'insertReplacementText') return true;
    if (!type.startsWith('delete')) return false;
    const range = this.targetRange(e);
    return (
      !!range &&
      !isCollapsed(range) &&
      range.anchor.blockId === range.focus.blockId &&
      range.anchor.cell?.row === range.focus.cell?.row &&
      range.anchor.cell?.col === range.focus.cell?.col
    );
  }

  /** Markdown shortcuts and suggestion menus that typing `text` triggers. */
  private afterTyping(text: string): void {
    // Shortcuts are separate undo steps, so undo restores the typed characters.
    if (text === ' ' || text === '-') this.run((s) => cmd.applyBlockInputRules(s));
    if (text.length === 1 && '*_`~'.includes(text)) this.run((s) => cmd.applyInlineInputRules(s));
    if (this.markdown.inline.length > 0) this.run((s) => cmd.applyTokenInputRules(s, this.markdown.inline) ?? s);
    if (text === ' ' && this.markdown.autolinks) this.run((s) => cmd.applyAutolinkInputRule(s) ?? s);
    if (!text.includes('\n')) this.typedForSuggestion();
  }

  private onCompositionStart(e: Event): void {
    if (this.fromControl(e)) return;
    this.dropBlockSelection();
    this.refreshSelection();
    // Replace a non-collapsed selection before the browser starts composing,
    // so the composition always happens inside one block.
    if (!isCollapsed(this.state.selection)) this.run(cmd.deleteSelection);
    this.composing = true;
    // Marks chosen before composing (Mod-B, then compose) apply to all of the composed text.
    this.composition = { blockId: this.state.selection.focus.blockId, marks: this.state.storedMarks, recorded: false };
    this.toolbar?.hide();
  }

  private onCompositionEnd(e: Event): void {
    if (this.fromControl(e)) return;
    if (!this.composition) {
      // A composition that started before the editor did.
      this.composing = false;
      this.reconcileFromDom('other');
      return;
    }
    // Read the committed text while still composing, so nothing moves the browser selection yet.
    this.syncComposition();
    this.composing = false;
    if (isSafari) this.compositionEndedAt = Date.now();
    this.unsettled.add(this.composition.blockId);
    // Render the block from the model once the browser is done with it: after
    // input that follows in the same task (Firefox sends the last one after
    // compositionend), and not during the next composition (the next Korean
    // syllable starts in the same keystroke).
    if (this.settleFrame === null) {
      const settle = () => {
        this.settleFrame = null;
        this.settleComposition();
      };
      if (typeof requestAnimationFrame === 'function') this.settleFrame = requestAnimationFrame(settle);
      else this.settleComposition();
    }
  }

  private settleComposition(): void {
    if (this.composing || this.destroyed) return;
    const composed = this.composition?.recorded;
    this.composition = null;
    for (const id of this.unsettled) this.renderer.invalidate(id);
    this.unsettled.clear();
    this.paint();
    this.afterRender();
    // Composed text opens a popup as typing does: a full-width slash opens the slash menu.
    if (composed) this.typedForSuggestion();
  }

  private onInput(e: InputEvent): void {
    if (this.fromControl(e)) return;
    // Composition input, and the last of it when it arrives after compositionend.
    if (this.composing || (this.composition && COMPOSITION_INPUT.has(e.inputType))) {
      const before = this.composedLength();
      this.syncComposition();
      // Composed text that grew opens a popup as typing does (Android composes every word).
      if (this.composing && this.composedLength() > before) this.typedForSuggestion();
      return;
    }
    if (e.isComposing) return;
    // Reached when the browser changed the DOM despite beforeinput, or for input that could not be cancelled.
    const before = this.state;
    this.reconcileFromDom('typing');
    if (e.inputType === 'insertText' && e.data && this.state !== before) this.afterTyping(e.data);
  }

  /** The length of the composed block's or cell's text. */
  private composedLength(): number {
    const pos = this.state.selection.focus;
    const block = this.state.doc.blocks.find((b) => b.id === this.composition?.blockId);
    const content = block && containerContent(block, block.id === pos.blockId ? pos.cell : undefined);
    return content ? inlineLength(content) : 0;
  }

  /**
   * Ends the composition on purpose: reads the composed text into the model
   * and renders the block from it, which ends the browser's composition.
   * Picking a suggestion item while composing does this first.
   */
  private endComposition(): void {
    if (!this.composing || !this.composition) return;
    this.syncComposition();
    this.composing = false;
    this.unsettled.add(this.composition.blockId);
    if (this.settleFrame !== null) cancelAnimationFrame(this.settleFrame);
    this.settleFrame = null;
    this.settleComposition();
  }

  /**
   * Reads the composed text into the model while composing. The browser's
   * DOM for the block already shows it, so the block is not re-rendered.
   */
  private syncComposition(): void {
    const composition = this.composition;
    if (!composition || this.readOnly) return;
    const before = this.state;
    const read = this.readDom(before, composition.marks, composition.blockId);
    if (!read) return;
    if (!composition.recorded) {
      this.history.record(before, 'other');
      composition.recorded = true;
    }
    const block = read.doc.blocks.find((b) => b.id === composition.blockId);
    if (block) this.renderer.adopt(block);
    const selection = this.readDomSelection();
    this.commit(selection ? { ...read, selection: clampSelection(read.doc, selection) } : read);
  }

  /**
   * Reads text back from the DOM and applies the difference to the model as
   * one delete and one insert per changed text container.
   */
  private reconcileFromDom(kind: ChangeKind): void {
    const read = this.readDom(this.state, this.state.storedMarks);
    if (!read) {
      // Text is unchanged but the browser may have altered structure.
      this.paint(true);
      return;
    }
    for (const block of read.doc.blocks) {
      if (block !== getBlock(this.state.doc, block.id)) this.renderer.invalidate(block.id);
    }
    const selection = this.readDomSelection() ?? read.selection;
    this.apply({ ...read, selection: clampSelection(read.doc, selection) }, kind);
  }

  /**
   * The model with the text the DOM shows: one delete and one insert per
   * changed text container, inserted text getting `marks` when set. Only
   * `blockId` when given. Null when the text is the same.
   */
  private readDom(from: EditorState, marks: EditorState['storedMarks'], blockId?: string): EditorState | null {
    let state = from;
    let changed = false;
    for (const block of from.doc.blocks) {
      if (blockId !== undefined && block.id !== blockId) continue;
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
        if (inserted) state = cmd.insertText({ ...state, storedMarks: marks }, inserted);
        changed = true;
      }
    }
    return changed ? state : null;
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.caretKey = null;
    if (this.fromControl(e)) return;
    if (e.isComposing || e.keyCode === 229) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    const handled = (fn: () => unknown) => {
      e.preventDefault();
      this.refreshSelection();
      fn();
    };

    // Safari sends the Enter that commits a composition after compositionend, with keyCode 229 in
    // shipped versions; as extra protection, the first key within 100 ms of it never reaches the popup.
    const justComposed = Date.now() - this.compositionEndedAt < 100;
    this.compositionEndedAt = 0;
    // Open menus take the navigation keys.
    if (this.suggestions.isOpen && !justComposed) {
      this.refreshSelection();
      if (this.suggestions.keydown(e)) {
        e.preventDefault();
        return;
      }
    }
    const menu = this.blockMenu.isOpen ? this.blockMenu : null;
    if (menu) {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) return handled(() => this.moveMenu(menu, 1));
      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) return handled(() => this.moveMenu(menu, -1));
      if (e.key === 'Enter' && menu.count > 0) return handled(() => menu.pick());
      if (e.key === 'Escape') return handled(() => this.closeBlockMenu());
    }

    if (e.key === 'Escape' && this.toolbar?.isOpen) {
      return handled(() => {
        this.toolbarClosedFor = this.state.selection;
        this.toolbar!.hide();
      });
    }
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

    // Backspace at the start of a block changes blocks: a heading becomes a
    // paragraph, a divider above is removed. WebKit sends no beforeinput when
    // no editable text comes before the caret, so this is handled here.
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.refreshSelection();
      const { selection } = this.state;
      if (isCollapsed(selection) && selection.focus.offset === 0) {
        e.preventDefault();
        this.run(cmd.deleteBackward);
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
      // Step into the source of a rendered block, or into a table, which the browser may skip.
      const into = this.blockPast(e.key);
      if (into) {
        e.preventDefault();
        this.setSelection({ anchor: into, focus: into });
        return;
      }
      const vertical = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      // In a table, up and down go to the cell above or below; the browser would go to the next cell in the row.
      const cell = vertical ? this.tableCellPast(vertical) : null;
      if (cell) {
        e.preventDefault();
        this.setSelection({ anchor: cell, focus: cell });
        return;
      }
      // On the last line of a final code block or table (or the first line of
      // a first one), add a paragraph past it. Elsewhere the browser moves the caret.
      const next = vertical ? cmd.exitBlock(this.state, vertical) : this.state;
      if (next !== this.state) {
        e.preventDefault();
        this.run(() => next);
        return;
      }
    }
    if (CARET_KEY.test(e.key)) {
      // The browser moves the caret.
      this.refreshSelection();
      const plain = !mod && !e.shiftKey && !e.altKey;
      const vertical = !plain ? 0 : e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      const from = blockIndex(this.state.doc, this.state.selection.focus.blockId);
      this.caretKey = { from, x: this.selectionRect()?.left ?? 0, vertical };
    }
  }

  /** Selects all the text of the block (or table cell) holding `target`. False if it holds none. */
  private selectBlockText(target: HTMLElement): boolean {
    const blockEl = target.closest?.<HTMLElement>(`[${BLOCK_ATTR}]`);
    if (!blockEl || !this.root.contains(blockEl)) return false;
    const block = getBlock(this.state.doc, blockEl.getAttribute(BLOCK_ATTR)!);
    const cellEl = target.closest<HTMLElement>('[data-row]');
    const cell = block.type === 'table' && cellEl ? { row: Number(cellEl.dataset.row), col: Number(cellEl.dataset.col) } : undefined;
    const content = containerContent(block, cell);
    if (!content || (block.type === 'raw' && blockEl.classList.contains('mbe-view-block'))) return false;
    const at = (offset: number): Position => (cell ? { blockId: block.id, offset, cell } : { blockId: block.id, offset });
    this.setSelection({ anchor: at(0), focus: at(inlineLength(content)) });
    return true;
  }

  private moveMenu(menu: Menu, delta: number): void {
    menu.move(delta);
    this.syncActiveDescendant();
  }

  private onMouseDown(e: MouseEvent): void {
    this.caretKey = null;
    const target = e.target as HTMLElement;
    this.dropBlockSelection();
    if (target === this.root && e.button === 0 && !this.readOnly && this.clickBelowLastBlock(e)) return;
    const view = e.button === 0 && !this.readOnly ? target.closest?.<HTMLElement>('.mbe-view, .mbe-view-block') : null;
    if (view && this.root.contains(view)) {
      e.preventDefault();
      this.revealView(view);
      return;
    }
    // A triple click selects the text of one block (or cell), not the line break after it,
    // so typing replaces that block instead of joining it with the next.
    if (e.button === 0 && e.detail === 3 && !this.readOnly && this.selectBlockText(target)) {
      e.preventDefault();
      return;
    }
    if (e.button === 0) this.pointerDown = true;
    if (target.classList?.contains('mbe-checkbox')) {
      // Toggle in the model; keep the caret where it is.
      e.preventDefault();
      if (e.button === 0) this.toggleTaskAt(target);
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
      // Mouse presses toggle on mousedown. A click with no pointer comes from Space on a focused checkbox.
      e.preventDefault();
      if (e.detail === 0) this.toggleTaskAt(target);
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
    if (this.suggestions.isActive || this.toolbar?.isOpen || this.blockMenu.isOpen) this.updateUi();
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
  // Suggestion menus (see suggest/controller.ts)

  /** After typing: opens the suggestion whose token is at the caret, if any. */
  private typedForSuggestion(): void {
    if (this.suggestions.typed()) this.updateUi();
  }

  /** The slash menu, as a suggestion. */
  private slashSuggestion(): SuggestionConfig<SlashItem> {
    const ids = this.options.slashMenu || SLASH_ITEM_IDS;
    const items: SlashItem[] = ids
      .map((id) => BLOCK_ITEMS.find((b) => b.id === id))
      .filter((b): b is BlockItem => !!b)
      .map((b) => ({ id: b.id, label: this.labels[b.id], icon: this.icon(b.id), aliases: b.aliases, spec: b.spec }));
    return {
      name: 'slash',
      trigger: SLASH_CHARS,
      allowSpaces: true,
      emptyLabel: this.labels.noResults,
      label: this.labels.commands,
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
    this.suggestions.close();
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

  /** @internal The icon for a UI control: the `icons` option's entry, or the built-in Lucide icon. */
  icon(name: IconName): Icon {
    return this.options.icons?.[name] ?? builtinIcon(this.root.ownerDocument, name);
  }

  private blockMenuSections(blockId: string): MenuSection[] {
    const block = getBlock(this.state.doc, blockId);
    const sections: MenuSection[] = [];
    if (block.type === 'table' && this.state.selection.focus.blockId === blockId && this.state.selection.focus.cell) {
      sections.push({
        title: this.labels.tableSection,
        items: TABLE_ITEMS.map(({ id, action }) => ({
          id,
          label: this.labels[id],
          icon: this.icon(id),
          run: () => this.run((s) => cmd.tableAction(s, action)),
        })),
      });
    }
    sections.push({
      items: [
        { id: 'duplicate', label: this.labels.duplicate, icon: this.icon('duplicate'), run: () => this.run((s) => cmd.duplicateBlock(s, blockId)) },
        { id: 'delete', label: this.labels.delete, icon: this.icon('delete'), danger: true, run: () => this.run((s) => cmd.deleteBlock(s, blockId)) },
      ],
    });
    return sections;
  }

  /**
   * @internal
   * Only large blocks get the handle and block menu: tables and code blocks.
   * Other blocks change type through the slash menu or Markdown shortcuts.
   */
  hasBlockMenu(blockId: string): boolean {
    const block = this.state.doc.blocks.find((b) => b.id === blockId);
    return block?.type === 'table' || block?.type === 'code';
  }

  /** @internal Opens the block menu of a table or code block, as the block handle and Mod+/ do. */
  openBlockMenu(blockId: string, anchor?: DOMRect): void {
    if (this.readOnly || !this.hasBlockMenu(blockId)) return;
    this.dropBlockSelection();
    this.suggestions.close();
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

  /** @internal Opens the link popover for the selection, as Mod+K does. */
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

    this.suggestions.update(focused);

    // Formatting toolbar.
    if (this.toolbar) {
      const block = this.state.doc.blocks.find((b) => b.id === pos.blockId);
      const closed = this.toolbarClosedFor;
      if (closed && !(samePosition(closed.anchor, this.state.selection.anchor) && samePosition(closed.focus, pos))) this.toolbarClosedFor = null;
      const show =
        !this.toolbarClosedFor &&
        focused &&
        !this.readOnly &&
        !this.composing &&
        !isCollapsed(this.state.selection) &&
        !this.blockSel &&
        !this.suggestions.isActive &&
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

  private syncActiveDescendant(): void {
    const id = this.suggestions.activeDescendant ?? (this.blockMenu.isOpen ? this.blockMenu.activeDescendant : null);
    if (id) this.root.setAttribute('aria-activedescendant', id);
    else this.root.removeAttribute('aria-activedescendant');
  }

  private hideUi(): void {
    this.dropBlockSelection();
    this.suggestions.close();
    this.blockMenu.hide();
    this.toolbar?.hide();
    this.handle.hide();
    this.hintEl?.classList.remove('mbe-show-hint');
    this.hintEl = null;
  }

  /** Wraps an input event handler so the changes it makes keep the caret in view. */
  private typed(fn: (e: Event) => void): (e: Event) => void {
    return (e) => {
      this.typing++;
      try {
        fn(e);
      } finally {
        this.typing--;
      }
    };
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

/** Accessible name of a task checkbox: its item's text, or `fallback` when the item is empty. */
function taskName(box: HTMLElement, fallback: string): string {
  const text = box.closest('[data-block-id]')?.querySelector('.mbe-content')?.textContent?.trim();
  return text || fallback;
}
