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
import { htmlToDoc, isStyledText } from './clipboard/fromHtml';
import { type ChangeKind, History } from './history';
import { DEFAULT_LABELS, type Labels } from './labels';
import { type Icon, type IconName, type Icons, builtinIcon, iconNode } from './icons';
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
  CALLOUT_TYPES,
  type CalloutType,
  type Doc,
  type EditorState,
  type HeadingBlock,
  type CodeBlock,
  type HeadingLevel,
  type Mark,
  type ParagraphBlock,
  type Position,
  type RawBlock,
  type Selection,
  blockIndex,
  clampSelection,
  containerContent,
  createState,
  endOf,
  getBlock,
  imageBlockOffset,
  inlineLength,
  inlineText,
  isCollapsed,
  isImageBlock,
  isPlainTextBlock,
  isTextless,
  isTextBlock,
  linkAt,
  paragraph,
  plain,
  samePosition,
  sliceInline,
  startOf,
  quoteKind,
} from './model';
import { FormatToolbar, InputPopover, type ToolbarItem } from './ui/toolbar';
import { ImageToolbar } from './ui/imageToolbar';
import { BlockHandle } from './ui/blockHandle';
import { LinkCard, type LinkTarget } from './ui/linkCard';
import { ResizeHandles, type ImageTarget } from './ui/resizeHandles';
import { Menu, type MenuItem, type MenuSection, isMac, isSafari, isTouch, matches, setPopupContainer } from './ui/popup';
import { BLOCK_ATTR, BlockRenderer, atomAt, calloutName, childIndex, contentElement, domText, MARKDOWN_VIEW, domToPosition, positionToDom, type ResolveUrl, defaultResolveUrl } from './view/dom';
import { revealedViews, sameRevealed, viewEntry } from './view/reveal';
import { scrollRectIntoView } from './view/scroll';
import { FONT_PROPERTIES, type Theme, mergeClasses, tokenProperties } from './theme';
import { SourceHighlighter } from './sourceHighlight';
import * as src from './sourceMode';
import { type EditorMode, SOURCE_ID, isSourceDoc, sourceState, sourceText } from './sourceMode';

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
  /** `'source'` shows the whole document as its Markdown text. Default `'rich'`. */
  mode?: EditorMode;
  /**
   * In source mode, Enter continues a list or task item and Tab and
   * Shift+Tab nest list items. `false` makes Enter insert a line break and
   * Tab indent as in a code block. Default true. Fixed for the editor's lifetime.
   */
  smartLists?: boolean;
  /**
   * In source mode, the Markdown syntax is highlighted: markers dimmed,
   * strong text bold, emphasis italic, headings heavier, code and URLs
   * tinted (classes `mbe-src-*`). `false` leaves the text plain; the
   * extensions' decorations show either way. Default true. Fixed for the
   * editor's lifetime.
   */
  sourceHighlighting?: boolean;
  /** Focus on creation: `true` or `'start'` puts the caret at the start, `'end'` at the end. */
  autofocus?: boolean | 'start' | 'end';
  /** Attributes for the editable root, such as `autocorrect` or `aria-label`. */
  attributes?: Readonly<Record<string, string>>;
  /**
   * Maps a link's or image's URL to the URL to use, or null to drop it: the
   * link is not clickable, the image has no `src`. The saved Markdown keeps
   * the original. Default `defaultResolveUrl`: relative URLs, `http`, `https`,
   * `mailto` and `tel`.
   */
  resolveUrl?: ResolveUrl;
  /** `referrerpolicy` for images, such as `no-referrer`. Fixed for the editor's lifetime. */
  referrerPolicy?: ReferrerPolicy;
  /** A copy button on code blocks, which copies the code. Default true. Fixed for the editor's lifetime. */
  codeCopy?: boolean;
  /**
   * Element ids for the document's headings, for in-page links and an
   * outline: called with every heading in order, returns an id (or
   * undefined) for each. Called again when the document changes. Fixed for
   * the editor's lifetime.
   */
  headingIds?: (headings: readonly { readonly text: string; readonly level: HeadingLevel }[]) => readonly (string | undefined)[];
  /**
   * Called when a link is clicked to be opened: a plain click while read-only,
   * Mod+click while editing. Return true to handle it, for example to route an
   * in-app link; otherwise the editor opens `href` in a new tab.
   */
  onLinkClick?: (ctx: { readonly editor: Editor; readonly href: string; readonly event: MouseEvent }) => boolean | void;
  /** Classes for rendered elements, colors and fonts, and the color scheme. See `Theme`. */
  theme?: Theme;
  /** Overrides UI strings. */
  labels?: Partial<Labels>;
  /** Replaces built-in icons, by the `labels` key of the same control. A string is shown as text; an element is cloned. */
  icons?: Icons;
  /**
   * Shows the formatting toolbar on selection. Default true. `items` picks
   * its controls; they always appear in the built-in order.
   */
  toolbar?: boolean | { items?: readonly ToolbarItem[] };
  /**
   * Shows the link card while editing: the link's URL and buttons to open,
   * copy, edit and remove it, when the pointer rests on a link or the caret
   * is inside one. Default true.
   */
  linkCard?: boolean;
  /**
   * The element menus, the toolbar and other popups are appended to.
   * Default: the nearest open `<dialog>` or `aria-modal` ancestor of
   * `element`, else `document.body`.
   */
  popupContainer?: HTMLElement;
  /** IDs of built-in slash menu items to show, in order, or false for no slash menu. See SLASH_ITEM_IDS. */
  slashMenu?: false | readonly SlashItemId[];
  /**
   * Shows `labels.slashHint` in the empty paragraph that has the caret.
   * Default false. Has no effect when `slashMenu` is false. Fixed for the
   * editor's lifetime.
   */
  slashHint?: boolean;
  /** Shortcut for `on('change')`, with the new Markdown. */
  onChange?: (markdown: string, editor: Editor) => void;
  /** Shortcut for `on('submit')`, with the current Markdown. */
  onSubmit?: (markdown: string, editor: Editor) => void;
  onFocus?: (editor: Editor) => void;
  onBlur?: (editor: Editor) => void;
}

/** Options that `setOptions` can change while the editor runs. */
export type RuntimeOptions = Pick<
  EditorOptions,
  'placeholder' | 'editable' | 'taskToggle' | 'mode' | 'attributes' | 'resolveUrl' | 'onLinkClick' | 'theme' | 'extensions'
>;

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
  | 'raw'
  /** The title of a collapsible section. */
  | 'details'
  /** The selection is exactly one image. */
  | 'image';

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
  /** Turns the selected blocks into a callout of `type` (default `note`), or back into paragraphs when they are one already. */
  toggleCallout(attrs?: { type?: CalloutType }): boolean;
  /** Changes the type of the callout with the caret, or turns the quote with the caret into a callout; `null` makes it a plain quote. */
  setCallout(attrs: { type: CalloutType | null }): boolean;
  /** Turns the block with the caret into the title of a collapsible section with an empty body, or, on a title, removes the section and keeps its blocks. */
  toggleDetails(): boolean;
  toggleCodeBlock(attrs?: { language?: string }): boolean;
  setLink(attrs: { href: string }): boolean;
  unsetLink(): boolean;
  /**
   * Changes the selected image (see `isActive('image')`): its alt text, its
   * title, its alignment (shown on image blocks), or its width in CSS pixels.
   * `null` removes the title, the alignment or the width.
   */
  updateImage(attrs: cmd.ImageChange): boolean;
  /** Inserts plain text at the selection, or in place of `range` (for example a suggestion's range). */
  insertText(text: string, options?: { range?: { from: Position; to: Position } }): boolean;
  /**
   * Inserts a token such as `#tag` at the caret as a word of its own: with a
   * space before it unless the caret is at the start of the text or after
   * whitespace, and a space after it, reusing one that is already there; the
   * caret ends after that space. Selected text is kept. The token is plain
   * text in a code block or source mode, as typed text is. Does nothing, and
   * returns false, while an input method is composing.
   */
  insertToken(text: string): boolean;
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
  'heading4',
  'bulletList',
  'numberedList',
  'todoList',
  'quote',
  'callout',
  'details',
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
  { id: 'heading4', aliases: ['h4'], spec: { type: 'heading', level: 4 } },
  { id: 'bulletList', aliases: ['ul', 'unordered', 'bullet'], spec: { type: 'listItem', listType: 'bullet' } },
  { id: 'numberedList', aliases: ['ol', 'ordered'], spec: { type: 'listItem', listType: 'ordered' } },
  { id: 'todoList', aliases: ['task', 'checkbox', 'checklist'], spec: { type: 'listItem', listType: 'task' } },
  { id: 'quote', aliases: ['blockquote', 'citation'], spec: { type: 'quote' } },
  { id: 'callout', aliases: ['alert', 'admonition', 'note', 'tip', 'important', 'warning', 'caution'], spec: { type: 'quote', callout: 'note' } },
  { id: 'details', aliases: ['toggle', 'collapse', 'collapsible', 'summary', 'spoiler', 'fold'], spec: { type: 'details' } },
  { id: 'code', aliases: ['pre', 'snippet', 'fence'], spec: { type: 'code' } },
  { id: 'table', aliases: ['grid'], spec: { type: 'table' } },
  { id: 'divider', aliases: ['hr', 'separator', 'line', 'rule'], spec: { type: 'divider' } },
];

/** Block actions for the table cell with the caret. Each label is `labels[id]`. The Align submenu goes after the first four. */
const TABLE_ACTIONS: readonly { id: IconName & keyof Labels; action: cmd.TableAction }[] = [
  { id: 'addRowAbove', action: { kind: 'addRowAbove' } },
  { id: 'addRowBelow', action: { kind: 'addRowBelow' } },
  { id: 'addColumnLeft', action: { kind: 'addColumnLeft' } },
  { id: 'addColumnRight', action: { kind: 'addColumnRight' } },
  { id: 'deleteRow', action: { kind: 'deleteRow' } },
  { id: 'deleteColumn', action: { kind: 'deleteColumn' } },
];

/** The Align submenu of the block menu, for a table column or an image block. */
const ALIGN_CHOICES = [
  { id: 'alignLeft', align: 'left', image: 'imageAlignLeft' },
  { id: 'alignCenter', align: 'center', image: 'imageAlignCenter' },
  { id: 'alignRight', align: 'right', image: 'imageAlignRight' },
] as const;

const SLASH_CHARS = ['/', '／'];

/** App UI inside the root that is not editor text: widgets, and block views placed after their block. Events from it are not editor input. */
const APP_UI = '.mbe-widget, .mbe-block-after';

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
  private readonly history = new History(() => this.source);
  /** Rich blocks, or the whole document as text in one block (see sourceMode.ts). */
  private modeValue: EditorMode = 'rich';
  /** A mode switch asked for during a composition, applied when it settles. */
  private pendingMode: EditorMode | null = null;
  private readonly renderer: BlockRenderer;
  private composing = false;
  /**
   * The current composition, kept until its block is rendered again: its
   * block, the marks for composed text, and whether it has an undo step yet.
   */
  private composition: { blockId: string; marks: EditorState['storedMarks']; recorded: boolean } | null = null;
  /** When the last composition ended (Safari only): the next key may be the Enter that committed it. */
  private compositionEndedAt = 0;
  /**
   * The last Markdown shortcut that typing applied: the state with the typed
   * characters, and the state the shortcut made. Backspace right after it
   * goes back to the typed characters.
   */
  private shortcut: { typed: EditorState; applied: EditorState } | null = null;
  /** Blocks the browser edited during a composition that ended, rendered again on the next frame. */
  private readonly unsettled = new Set<string>();
  private settleFrame: number | null = null;
  private readOnly: boolean;
  private wasReadOnly = false;
  /** Task checkboxes stay usable while read-only. */
  private taskToggle: boolean;
  private readonly smartLists: boolean;
  private readonly sourceHighlighting: boolean;
  /** Source mode's decorations, computed once per text; a long text gets them a moment after the keystroke (see `SourceHighlighter`). */
  private readonly sourceHighlighter: SourceHighlighter;
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
  /** The selection the formatting or image toolbar was closed for with Escape. It stays closed until the selection changes. */
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
  private readonly imageToolbar: ImageToolbar | null;
  /** The link popover, and the field for an image's alt text. */
  private readonly inputPopover: InputPopover;
  private readonly blockHandle: BlockHandle;
  /** Collapsible sections shown collapsed, by the ID of their title. View state: not saved, not undone. */
  private readonly collapsed = new Set<string>();
  private readonly linkCard: LinkCard | null;
  private readonly resizeHandles: ResizeHandles;
  /** The selected image's element, which carries the selected class. */
  private selectedImageEl: HTMLElement | null = null;
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
  /** The ids `headingIds` gave the headings of `doc`, by block ID. */
  private headingIdsFor: { doc: Doc; ids: Map<string, string | undefined> } | null = null;
  /** `redecorate()` was called during a composition; it runs when the composition settles. */
  private redecoratePending = false;
  /** The frame that renders blocks again after their views settled. */
  private viewFrame = 0;

  constructor(options: EditorOptions) {
    const root = options.element;
    this.root = root;
    this.options = options;
    this.runtime = {};
    this.labels = { ...DEFAULT_LABELS, ...options.labels };
    this.readOnly = options.editable === false;
    this.taskToggle = options.taskToggle === true;
    this.smartLists = options.smartLists !== false;
    this.sourceHighlighting = options.sourceHighlighting !== false;
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
    this.renderer.collapsed = this.collapsed;
    this.collapseClosedSections(this.current.doc);
    this.renderer.widgetsAfter = (blockId) => {
      if (this.widgets.length === 0) return undefined;
      const els = this.widgets.filter((w) => w.blockId === blockId).map((w) => w.element);
      return els.length ? els : undefined;
    };
    // Raw Markdown blocks are rendered by the editor itself (see MARKDOWN_VIEW).
    this.renderer.views = new Map([['markdown', MARKDOWN_VIEW], ...this.extensions.flatMap((e) => Object.entries(e.views ?? {}))]);
    this.renderer.viewContext = { editor: this };
    this.renderer.blockViews = this.extensions.flatMap((e) => (e.blockView ? [{ name: e.name, view: e.blockView }] : []));
    this.renderer.markdown = this.markdown;
    this.renderer.onViewSettled = (ids) => this.viewsSettled(ids);
    const codeDecorators = this.extensions.flatMap((e) => (e.codeDecorations ? [e.codeDecorations] : []));
    if (codeDecorators.length > 0) {
      this.renderer.decorateCode = (block) => {
        const ctx = { block, text: inlineText(block.content), language: block.language };
        return codeDecorators.flatMap((fn) => fn(ctx));
      };
    }
    const decorators = this.extensions.flatMap((e) => (e.decorations ? [e.decorations] : []));
    if (decorators.length > 0) {
      this.renderer.decorate = (block, content, cell) => {
        const ctx = decorationContext(block, content, cell);
        return decorators.flatMap((fn) => fn(ctx));
      };
    }
    // Source mode: the Markdown's own highlighting, the decorators over the text
    // split at its syntax, and the code decorators over each code block in it.
    this.sourceHighlighter = new SourceHighlighter(
      this.markdown,
      () => ({ highlight: this.sourceHighlighting, classes: this.renderer.classes.source, decorators, codeDecorators }),
      () => this.refreshSource(),
    );
    this.renderer.decorateSource = (block) => this.sourceHighlighter.decorations(block);
    this.commands = this.createCommands();

    root.classList.add('mbe-root');
    root.setAttribute('role', 'textbox');
    root.setAttribute('aria-multiline', 'true');
    root.spellcheck = true;
    root.translate = false;
    root.style.setProperty('--mbe-slash-hint', JSON.stringify(this.labels.slashHint));
    this.applyRuntime({ placeholder: options.placeholder, attributes: options.attributes });
    this.runtime = { ...this.runtime, resolveUrl: options.resolveUrl, onLinkClick: options.onLinkClick };
    this.renderer.resolveUrl = options.resolveUrl ?? defaultResolveUrl;
    this.renderer.referrerPolicy = options.referrerPolicy;
    this.renderer.codeCopy = options.codeCopy !== false;
    this.renderer.icon = (name) => iconNode(root.ownerDocument, this.icon(name));
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
    this.blockMenu.onHighlight = () => this.syncActiveDescendant();
    this.blockMenu.checkIcon = this.icon('selected');
    this.blockMenu.submenuIcon = this.icon('chevronRight');
    this.inputPopover = new InputPopover(this);
    this.toolbar = options.toolbar === false ? null : new FormatToolbar(this, typeof options.toolbar === 'object' ? options.toolbar.items : undefined);
    if (this.toolbar) this.toolbar.onMenuChange = () => this.syncActiveDescendant();
    this.imageToolbar =
      options.toolbar === false
        ? null
        : new ImageToolbar(this, {
            // An image without an alignment sits on the left, so Left removes the word.
            align: (target, align) => this.updateImageAt(target.pos, { align: align === 'left' ? null : align }),
            altText: (target) => this.editAltText(target.pos, target.image.alt),
            resetSize: (target) => this.updateImageAt(target.pos, { width: null }),
            remove: (target) => this.deleteImageAt(target.pos),
          });
    this.blockHandle = new BlockHandle(this);
    this.linkCard =
      options.linkCard === false
        ? null
        : new LinkCard(this, {
            open: (target, event) => this.openHref(target.el.getAttribute('href'), event),
            edit: (target) => this.editLink(target),
            remove: (target) => this.removeLink(target),
            targetOf: (el) => this.linkTargetOf(el),
          });
    this.resizeHandles = new ResizeHandles(this);
    this.renderer.onImageError = () => {
      if (this.destroyed) return;
      if (!this.composing) this.syncDomSelection();
      this.updateUi();
    };

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
    this.listen(root.ownerDocument, 'pointerdown', (e) => this.onDocumentPointerDown(e), true);

    if (options.mode === 'source') this.enterSource();
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
    if (this.modeValue === 'source') return sourceText(this.current.doc);
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
    if (this.modeValue === 'source') {
      this.suggestions.reset();
      this.current = sourceState(markdown, 0);
      for (const widget of this.widgets) widget.offset = Math.min(widget.offset, markdown.length);
      this.paint(true, true);
      this.afterRender();
      this.emit('selectionChange', { editor: this });
      return;
    }
    const loaded = loadMarkdown(markdown, this.markdown);
    this.source = loaded.source;
    this.blockSel = null;
    this.suggestions.reset();
    const next = createState(loaded.doc);
    this.collapsed.clear();
    this.collapseClosedSections(next.doc);
    this.relocateWidgets(this.current.doc, next.doc, true);
    this.current = next;
    this.paint(true, true);
    this.afterRender();
    this.emit('selectionChange', { editor: this });
  }

  /** True when the document holds only empty paragraphs. */
  get isEmpty(): boolean {
    if (this.modeValue === 'source') return sourceText(this.current.doc) === '';
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

  /** `'rich'` or `'source'`: the mode the editor shows now. */
  get mode(): EditorMode {
    return this.pendingMode ?? this.modeValue;
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
    if (this.modeValue === 'source') return false;
    const s = this.current;
    switch (name) {
      case 'bold':
      case 'italic':
      case 'strike':
      case 'code':
        return cmd.isMarkActive(s, name);
      case 'link':
        return cmd.activeLink(s) !== null;
      case 'image': {
        const selected = cmd.selectedImage(s);
        if (!selected || !attrs) return selected !== null;
        const actual: Record<string, unknown> = { ...selected.image, block: cmd.selectedImageBlock(s) !== null };
        return Object.entries(attrs).every(([k, v]) => actual[k] === v);
      }
    }
    const block = getBlock(s.doc, s.selection.focus.blockId);
    if (blockName(block) !== name && !(name === 'blockquote' && quoteKind(block))) return false;
    if (!attrs) return true;
    const actual = this.getAttributes(name);
    return Object.entries(attrs).every(([k, v]) => actual[k] === v);
  }

  /** Attributes of `name` at the selection: `src`, `alt`, `title`, `align`, `width`, `height` and `block` (true for an image block) for a selected image, `href` for a link, `level` for a heading, `language` for a code block, `checked` for a task, `syntax` for a raw block, `callout` for a callout, `open` (saved as `<details open>`) and `collapsed` (shown collapsed now) for a section title. */
  getAttributes(name: ActiveName): Record<string, unknown> {
    if (this.modeValue === 'source') return {};
    const s = this.current;
    if (name === 'link') {
      const link = cmd.activeLink(s);
      return link ? { href: link.href } : {};
    }
    if (name === 'image') {
      const selected = cmd.selectedImage(s);
      return selected ? { ...selected.image, block: cmd.selectedImageBlock(s) !== null } : {};
    }
    const block = getBlock(s.doc, s.selection.focus.blockId);
    // A list item in a quote is in the list and in the quote.
    const kind = quoteKind(block);
    if (name === 'blockquote' && kind) return kind === 'quote' ? {} : { callout: kind };
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
      case 'quote':
        return block.callout ? { callout: block.callout } : {};
      case 'details':
        return { open: block.open, collapsed: this.collapsed.has(block.id) };
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
    return !!active && this.root.contains(active) && !(active instanceof HTMLInputElement) && !active.closest(APP_UI);
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
    if (this.modeValue === 'source') widget.offset = options.at === 'end' ? sourceText(this.current.doc).length : at.offset;
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
   * `resolveUrl`, `onLinkClick` or `theme`. `extensions` only updates the callbacks of
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
      // Footnote definitions are collected at the end only when read-only, so the change renders.
      if (this.renderer.views?.has('footnote')) this.paint();
      else this.refreshRevealed();
      this.applyReadOnly();
      this.hideUi();
    } else if (toggle) {
      this.applyReadOnly();
    }
    this.applyRuntime(options);
    if (options.mode !== undefined) this.setMode(options.mode);
  }

  // -------------------------------------------------------------------------
  // Source mode (see sourceMode.ts and docs/architecture.md, "Source mode")

  /**
   * Shows the document as blocks or as its Markdown text. The text does not
   * change, so this emits no `change` and records no undo step. During a
   * composition the switch waits for it to settle.
   */
  private setMode(mode: EditorMode): void {
    if (mode !== 'rich' && mode !== 'source') return;
    if (this.composing || this.composition) {
      this.pendingMode = mode === this.modeValue ? null : mode;
      return;
    }
    this.pendingMode = null;
    if (mode === this.modeValue) return;
    const hadFocus = this.hasFocus();
    const caretTop = this.caretRect()?.top;
    this.blockSel = null;
    this.shortcut = null;
    this.suggestions.reset();
    this.hideUi();
    this.closeBlockMenu();
    this.history.breakGroup();
    if (mode === 'source') this.enterSource();
    else this.leaveSource();
    this.paint(true, false, hadFocus);
    this.afterRender();
    // The caret's line stays where it was on screen.
    const after = this.caretRect()?.top;
    if (caretTop !== undefined && after !== undefined && Math.abs(after - caretTop) > 1) scrollBy(this.root, after - caretTop);
    this.emit('selectionChange', { editor: this });
  }

  /** Rich blocks to text: the text is `getMarkdown()`; the selection and widgets keep their blocks. */
  private enterSource(): void {
    const { doc, selection } = this.current;
    const text = this.getMarkdown();
    const loaded = loadMarkdown(text, this.markdown);
    const sel = src.selectionToSource(doc, selection, loaded);
    for (const widget of this.widgets) {
      widget.offset = src.blockEndOffset(doc, widget.blockId, loaded);
      widget.blockId = SOURCE_ID;
    }
    this.collapsed.clear();
    this.current = sourceState(text, sel.anchor, sel.focus);
    this.modeValue = 'source';
    this.renderer.source = true;
    this.root.classList.add('mbe-source-mode');
  }

  /** Text to rich blocks, loaded as `setMarkdown` does, so the text saves byte for byte. */
  private leaveSource(): void {
    const { anchor, focus } = this.current.selection;
    const loaded = this.loadSource(sourceText(this.current.doc));
    for (const widget of this.widgets) widget.blockId = src.fromSourceOffset(widget.offset, loaded).blockId;
    const sel = src.selectionFromSource(anchor.offset, focus.offset, loaded);
    this.current = { doc: loaded.doc, selection: clampSelection(loaded.doc, sel), storedMarks: null };
    this.modeValue = 'rich';
    this.renderer.source = false;
    this.root.classList.remove('mbe-source-mode');
  }

  /** Loads text as the document's blocks, with an empty paragraph for empty text, and makes its source current. */
  private loadSource(text: string): { doc: Doc; source: MarkdownSource } {
    const loaded = loadMarkdown(text, this.markdown);
    const doc = createState(loaded.doc).doc;
    this.source = loaded.source;
    this.collapsed.clear();
    this.collapseClosedSections(doc);
    return { doc, source: loaded.source };
  }

  /** A history entry, in the current mode: an entry made in the other mode is serialized or loaded. */
  private restore(entry: { state: EditorState; source: MarkdownSource }): EditorState {
    const { state } = entry;
    const isSource = isSourceDoc(state.doc);
    if (this.modeValue === 'source') {
      if (isSource) return state;
      const text = serializeMarkdown(state.doc, { ...this.markdown, source: entry.source });
      const sel = src.selectionToSource(state.doc, state.selection, loadMarkdown(text, this.markdown));
      return sourceState(text, sel.anchor, sel.focus);
    }
    if (!isSource) {
      this.source = entry.source;
      return state;
    }
    const loaded = this.loadSource(sourceText(state.doc));
    const sel = src.selectionFromSource(state.selection.anchor.offset, state.selection.focus.offset, loaded);
    return { doc: loaded.doc, selection: clampSelection(loaded.doc, sel), storedMarks: null };
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
      // Shown through CSS, and named for assistive technology, which does not read CSS content.
      if (options.placeholder) {
        root.style.setProperty('--mbe-placeholder', JSON.stringify(options.placeholder));
        root.setAttribute('aria-placeholder', options.placeholder);
      } else {
        root.style.removeProperty('--mbe-placeholder');
        root.removeAttribute('aria-placeholder');
      }
      this.runtime = { ...this.runtime, placeholder: options.placeholder };
    }
    if ('attributes' in options) {
      for (const name of Object.keys(this.runtime.attributes ?? {})) root.removeAttribute(name);
      for (const [name, value] of Object.entries(options.attributes ?? {})) root.setAttribute(name, value);
      this.runtime = { ...this.runtime, attributes: options.attributes };
    }
    if ('resolveUrl' in options && options.resolveUrl !== this.runtime.resolveUrl) {
      this.runtime = { ...this.runtime, resolveUrl: options.resolveUrl };
      this.renderer.resolveUrl = options.resolveUrl ?? defaultResolveUrl;
      this.paint(true);
    }
    if ('onLinkClick' in options) this.runtime = { ...this.runtime, onLinkClick: options.onLinkClick };
    if ('theme' in options && this.applyTheme(options.theme)) this.paint(true);
  }

  /** Sets the theme. Returns true when every block must re-render, for new classes. */
  private applyTheme(theme: Theme | undefined): boolean {
    const before = tokenProperties(this.runtime.theme?.tokens);
    this.runtime = { ...this.runtime, theme };
    // Tokens and the color scheme are custom properties and CSS: no re-render.
    const style = this.root.style;
    const props = tokenProperties(theme?.tokens);
    for (const name of this.tokenNames) if (!props.has(name)) style.removeProperty(name);
    for (const [name, value] of props) style.setProperty(name, value);
    this.tokenNames = [...props.keys()];
    const scheme = theme?.colorScheme ?? 'auto';
    style.colorScheme = scheme === 'auto' ? '' : scheme;
    // A view that measured text (a diagram) laid it out for the old font: its blocks render again.
    if (FONT_PROPERTIES.some((name) => before.get(name) !== props.get(name))) this.renderBlocksAgain(this.renderer.dropViews());
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
    next = cmd.balanceSections(next);
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
      // Without callouts or sections in the Markdown dialect, they would not read back as such.
      toggleCallout: (attrs = {}) => this.markdown.callouts && block({ type: 'quote', callout: attrs.type ?? 'note' }),
      toggleDetails: () => this.markdown.details && block({ type: 'details' }),
      setCallout: ({ type }) => (this.markdown.callouts || type === null) && run((s) => cmd.setCallout(s, s.selection.focus.blockId, type)),
      toggleCodeBlock: (attrs = {}) => block({ type: 'code', language: attrs.language }),
      setLink: ({ href }) => run((s) => cmd.setLink(s, href)),
      unsetLink: () => run((s) => cmd.setLink(s, null)),
      updateImage: (attrs) =>
        run((s) => {
          const selected = cmd.selectedImage(s);
          return selected ? cmd.updateImage(s, selected.pos, attrs) : null;
        }),
      insertText: (text, options = {}) =>
        run((s) => {
          const range = options.range;
          if (!range) return cmd.insertText(s, text);
          const selection = clampSelection(s.doc, { anchor: range.from, focus: range.to });
          return cmd.insertText({ ...s, selection, storedMarks: null }, text);
        }),
      insertToken: (text) => !this.composing && run((s) => cmd.insertToken(s, text)),
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
    // Source mode is plain text: indent works as in a code block, insertMarkdown inserts text, and the
    // formatting and block commands do nothing (see docs/architecture.md, "Source mode").
    const rich = { ...commands };
    const inSource = <A extends unknown[]>(name: keyof EditorCommands, fn: ((...args: A) => boolean) | null) => {
      const richFn = rich[name] as unknown as (...args: A) => boolean;
      (commands as unknown as Record<string, (...args: A) => boolean>)[name] = (...args: A) =>
        this.modeValue === 'source' ? (fn ? fn(...args) : false) : richFn(...args);
    };
    const indentSource = (delta: 1 | -1) => run((s) => (this.smartLists ? src.sourceIndentList(s, delta) : null) ?? cmd.indentCode(s, delta));
    inSource('indent', () => indentSource(1));
    inSource('outdent', () => indentSource(-1));
    inSource('insertMarkdown', (markdown: string, options: InsertMarkdownOptions = {}) => this.insertSourceMarkdown(markdown, options));
    for (const name of [
      'toggleBold',
      'toggleItalic',
      'toggleStrike',
      'toggleCode',
      'setParagraph',
      'toggleHeading',
      'toggleBulletList',
      'toggleOrderedList',
      'toggleTaskList',
      'toggleBlockquote',
      'toggleCallout',
      'setCallout',
      'toggleDetails',
      'toggleCodeBlock',
      'setLink',
      'unsetLink',
      'updateImage',
      'insertTable',
      'insertDivider',
      'selectBlocks',
    ] as const) {
      inSource(name, null);
    }
    // After destroy every command does nothing, so late callbacks (an upload
    // that finishes after the editor closed) cannot render into the element.
    for (const name of Object.keys(commands) as (keyof EditorCommands)[]) {
      const fn = commands[name] as (...args: unknown[]) => boolean;
      (commands as unknown as Record<string, (...args: unknown[]) => boolean>)[name] = (...args) => !this.destroyed && fn(...args);
    }
    return commands;
  }

  private toggleMark(mark: Mark): boolean {
    if (this.modeValue === 'source') return false;
    return this.run((s) => cmd.toggleMark(s, mark));
  }

  /** `insertMarkdown` in source mode: the Markdown is inserted as text. */
  private insertSourceMarkdown(markdown: string, options: InsertMarkdownOptions): boolean {
    const at = options.at ?? 'selection';
    const keep = options.select === 'keep';
    const block = options.block === true;
    if (at instanceof WidgetImpl) {
      if (at.isRemoved) return false;
      return this.run((s) => src.insertSourceAt(s, at.offset, markdown, true, keep));
    }
    if (at === 'selection' && !block && !keep) return this.run((s) => src.insertSourceText(s, markdown));
    return this.run((s) => {
      let state = s;
      let offset: number;
      if (at === 'selection') {
        const { from, to } = src.sourceRange(s);
        if (from !== to) state = src.insertSourceText(s, '');
        offset = from;
      } else {
        offset = at === 'end' ? sourceText(s.doc).length : (at as Position).offset;
      }
      return src.insertSourceAt(state, offset, markdown, block, keep);
    });
  }

  private undo(): boolean {
    if (this.readOnly) return false;
    const next = this.history.undo(this.current);
    if (!next) return false;
    this.commit(this.restore(next));
    return true;
  }

  private redo(): boolean {
    if (this.readOnly) return false;
    const next = this.history.redo(this.current);
    if (!next) return false;
    this.commit(this.restore(next));
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
    this.sourceHighlighter.destroy();
    for (const fn of this.cleanup) fn();
    this.suggestions.destroy();
    for (const widget of [...this.widgets]) widget.remove();
    this.blockMenu.destroy();
    this.toolbar?.destroy();
    this.imageToolbar?.destroy();
    this.inputPopover.destroy();
    this.blockHandle.destroy();
    this.linkCard?.destroy();
    this.resizeHandles.destroy();
    this.renderer.destroy();
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
    if (docChanged && this.modeValue === 'source') {
      const before = sourceText(this.current.doc);
      const after = sourceText(next.doc);
      for (const widget of this.widgets) widget.offset = src.mapOffset(widget.offset, before, after);
    } else if (docChanged) {
      this.relocateWidgets(this.current.doc, next.doc, false);
    }
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
      if (block.type === 'heading') hint = this.labels[`heading${Math.min(block.level, 4)}` as 'heading1'];
      else if (block.type === 'listItem') hint = this.labels.listHint;
      else if (block.type === 'quote' && !block.callout) hint = this.labels.quoteHint;
      else if (block.type === 'details') hint = this.labels.detailsHint;
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
    const focus = isCollapsed(target) ? anchor : this.toDom(target.focus);
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
    const collapsed = sel.anchorNode === sel.focusNode && sel.anchorOffset === sel.focusOffset;
    const focus = collapsed ? anchor : domToPosition(this.root, sel.focusNode, sel.focusOffset);
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
    this.shortcut = null;
    const skipped = key?.vertical ? this.skippedBlock(key.from, key.vertical, key.x, selection.focus) : null;
    // A caret cannot sit beside the image of an image block, as a click next to it would put it: select the image.
    const image = this.imageBlockAt(skipped ? { anchor: skipped, focus: skipped } : selection);
    if (image) {
      if (!samePosition(image.anchor, cur.anchor) || !samePosition(image.focus, cur.focus)) this.setSelection(image);
      else this.updateUi();
    } else if (skipped) {
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

  /** The selection of an image block's image, when `sel` is a caret in that block. */
  private imageBlockAt(sel: Selection): Selection | null {
    if (!isCollapsed(sel) || sel.focus.cell) return null;
    const block = this.state.doc.blocks.find((b) => b.id === sel.focus.blockId);
    const offset = block ? imageBlockOffset(block) : null;
    if (offset === null) return null;
    return { anchor: { blockId: block!.id, offset }, focus: { blockId: block!.id, offset: offset + 1 } };
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
      if (!this.skipsCaret(block)) return this.blockEntry(block, dir === 1, x);
    }
    return null;
  }

  /** Where the caret goes moving into `block` from above (`forward`) or below: its first or last line, at `x`. */
  private blockEntry(block: Block, forward: boolean, x: number): Position {
    const el = this.renderer.elementFor(block.id);
    const viewed = this.viewBlock(block);
    if (viewed) return viewEntry(viewed, forward);
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
    if (views && !this.pointerDown && !this.composing) this.renderer.revealed = revealedViews(this.state, views, !this.readOnly && hadFocus, this.hosted);
    this.renderer.collectFootnotes = this.readOnly;
    this.renderer.render(this.state.doc, force, lazy);
    this.applyHeadingIds();
    this.applyReadOnly();
    this.paintBlockSelection();
    // Moving the browser selection would end the composition.
    if (!this.composing) this.syncDomSelection(hadFocus);
  }

  /** Source mode's block with the exact markup, once it is read: only the lines whose highlighting changed are rendered again. */
  private refreshSource(): void {
    if (this.destroyed || this.modeValue !== 'source' || this.composing || this.composition) return;
    const block = this.current.doc.blocks[0];
    if (block?.type !== 'code') return;
    const hadFocus = this.hasFocus();
    this.renderer.refreshSource(block);
    if (!this.pointerDown) this.syncDomSelection(hadFocus);
  }

  /** Heading ids from the `headingIds` option, computed again only when the document changes. */
  private applyHeadingIds(): void {
    const headingIds = this.options.headingIds;
    if (!headingIds) return;
    const doc = this.state.doc;
    if (this.headingIdsFor?.doc !== doc) {
      const headings = doc.blocks.filter((b): b is HeadingBlock => b.type === 'heading');
      const ids = headingIds(headings.map((h) => ({ text: inlineText(h.content), level: h.level })));
      this.headingIdsFor = { doc, ids: new Map(headings.map((h, i) => [h.id, ids[i]])) };
    }
    for (const [blockId, id] of this.headingIdsFor.ids) {
      const el = this.renderer.elementFor(blockId);
      if (!el) continue;
      if (id) {
        if (el.id !== id) el.id = id;
      } else if (el.id) {
        el.removeAttribute('id');
      }
    }
  }

  /**
   * Computes decorations again for every block and renders the blocks whose
   * decorations depend on something outside the document changed, such as
   * which mentioned people exist or a highlighter's language that finished
   * loading. Waits for an input method to finish composing.
   */
  redecorate(): void {
    if (this.destroyed) return;
    if (this.composing || this.composition) {
      this.redecoratePending = true;
      return;
    }
    this.redecoratePending = false;
    this.sourceHighlighter.reset();
    this.paint(true);
    this.afterRender();
  }

  /**
   * Renders every view (`Extension.views`) again, or those of one syntax
   * (`'math'`, `'code:mermaid'`), for when what a view shows depends on
   * something besides its source that changed: a renderer that finished
   * loading, or the font a diagram measured its text with. A view that
   * failed is tried again. Only the blocks that show those views render
   * again. The editor calls it itself when the theme's font tokens change.
   * Waits for an input method to finish composing.
   */
  refreshViews(syntax?: string): void {
    if (this.destroyed) return;
    this.renderBlocksAgain(this.renderer.dropViews(syntax));
  }

  /** Renders the given blocks again now, or when the composition in progress settles. */
  private renderBlocksAgain(ids: readonly string[]): void {
    if (ids.length === 0) return;
    if (this.composing || this.composition) {
      for (const id of ids) this.unsettled.add(id);
      return;
    }
    for (const id of ids) this.renderer.invalidate(id);
    this.paint();
    this.afterRender();
  }

  /**
   * Views that returned a promise settled: their blocks render again on the
   * next frame, or when a composition settles, since rendering would end it.
   */
  private viewsSettled(ids: readonly string[]): void {
    if (this.destroyed) return;
    if (this.composing || this.composition) {
      for (const id of ids) this.unsettled.add(id);
      return;
    }
    for (const id of ids) this.renderer.invalidate(id);
    this.viewFrame ||= requestAnimationFrame(() => {
      this.viewFrame = 0;
      if (this.destroyed || this.composing || this.composition) return;
      this.paint();
      this.afterRender();
    });
  }

  /** A block rendered by a view (a formula block, a diagram, a block an extension's block view draws), or null. */
  private viewBlock(block: Block | undefined): Block | null {
    if (!block) return null;
    return this.renderer.elementFor(block.id)?.classList.contains('mbe-view-block') ? block : null;
  }

  /** Re-renders if the views that show their source changed: after the selection, focus or editability changes. */
  private refreshRevealed(): void {
    const views = this.renderer.views;
    if (!views || this.pointerDown) return;
    const next = revealedViews(this.state, views, !this.readOnly && this.hasFocus(), this.hosted);
    if (!sameRevealed(next, this.renderer.revealed)) this.paint();
  }

  /** Whether an extension's block view draws `block` (see `BlockView`). */
  private readonly hosted = (block: Block): boolean => this.renderer.isHosted(block);

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
    const view = this.viewBlock(next);
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
    // A table is entered in its first column, like a view's source at its start or end.
    return viewEntry(next, forward);
  }

  /**
   * An arrow key next to an image block: from the edge of the block before
   * or after it, the selection of its image; from a selected image block, a
   * caret in the next block that holds one, or the same selection when there
   * is none. Null when no image block is involved.
   */
  private imageBlockStep(key: string): Selection | null {
    const sel = this.state.selection;
    const blocks = this.state.doc.blocks;
    const forward = key === 'ArrowDown' || key === 'ArrowRight';
    const selected = cmd.selectedImageBlock(this.state);
    if (selected) {
      const index = blockIndex(this.state.doc, selected.pos.blockId);
      for (let i = index + (forward ? 1 : -1); i >= 0 && i < blocks.length; i += forward ? 1 : -1) {
        const block = blocks[i]!;
        if (this.skipsCaret(block)) continue;
        const offset = imageBlockOffset(block);
        if (offset !== null) return { anchor: { blockId: block.id, offset }, focus: { blockId: block.id, offset: offset + 1 } };
        const vertical = key === 'ArrowDown' || key === 'ArrowUp';
        const pos = vertical ? this.blockEntry(block, forward, this.selectionRect()?.left ?? 0) : forward ? startOf(block) : endOf(block);
        return { anchor: pos, focus: pos };
      }
      return sel;
    }
    if (!isCollapsed(sel) || sel.focus.cell) return null;
    const index = blockIndex(this.state.doc, sel.focus.blockId);
    const current = blocks[index]!;
    const next = blocks[index + (forward ? 1 : -1)];
    const offset = next ? imageBlockOffset(next) : null;
    if (!next || offset === null || !isTextBlock(current)) return null;
    if (key === 'ArrowRight' && sel.focus.offset !== endOf(current).offset) return null;
    if (key === 'ArrowLeft' && sel.focus.offset !== 0) return null;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const content = contentElement(this.renderer.elementFor(current.id)!);
      if (content && !this.onEdgeLine(content, forward)) return null;
    }
    return { anchor: { blockId: next.id, offset }, focus: { blockId: next.id, offset: offset + 1 } };
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
      if (this.skipsCaret(next)) continue;
      if (next.type === 'table') {
        const r = dir === 1 ? 0 : next.rows.length - 1;
        const c = Math.min(col, next.align.length - 1);
        return { blockId: next.id, offset: dir === 1 ? 0 : inlineLength(next.rows[r]![c]!), cell: { row: r, col: c } };
      }
      const viewed = this.viewBlock(next);
      if (viewed) return viewEntry(viewed, dir === 1);
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
    const pos = block ? viewEntry(block, false) : domToPosition(this.root, view.parentNode!, childIndex(view) + 1);
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
    return e.target instanceof HTMLInputElement || !!(e.target as Element | null)?.closest?.(APP_UI);
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
    // Typing does not replace a selected image block; Enter and deleting still work.
    if ((type === 'insertText' || type === 'insertReplacementText') && cmd.selectedImageBlock(this.state)) return;
    if (this.modeValue === 'source' && this.onSourceInput(type)) return;

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
        this.run((s) => (this.collapsed.has(s.selection.focus.blockId) ? cmd.splitCollapsedTitle(s) : cmd.splitBlock(s)));
        return;
      }
      case 'insertLineBreak':
        this.run(cmd.insertLineBreak);
        return;
      case 'deleteContentBackward':
        if (!this.undoShortcut()) this.run(cmd.deleteBackward);
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
          this.run(
            this.modeValue === 'source'
              ? type.endsWith('Backward')
                ? (s) => src.sourceDeleteBackward(s, cmd.previousGrapheme)
                : (s) => src.sourceDeleteForward(s, cmd.nextGrapheme)
              : type.endsWith('Backward')
                ? cmd.deleteBackward
                : cmd.deleteForward,
          );
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

  /** Input that works differently on text in source mode. Returns true when handled. */
  private onSourceInput(type: string): boolean {
    switch (type) {
      case 'insertParagraph':
        this.run((s) => (this.smartLists ? src.sourceEnter(s) : src.insertSourceText(s, '\n')));
        return true;
      case 'insertLineBreak':
        this.run((s) => src.insertSourceText(s, '\n'));
        return true;
      case 'deleteContentBackward':
        this.run((s) => src.sourceDeleteBackward(s, cmd.previousGrapheme));
        return true;
      case 'deleteContentForward':
        this.run((s) => src.sourceDeleteForward(s, cmd.nextGrapheme));
        return true;
      default:
        return false;
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
    if (this.modeValue === 'source') {
      // Plain text: no Markdown shortcuts, autolinks or suggestions.
      this.shortcut = null;
      return;
    }
    // Shortcuts are separate undo steps, so undo restores the typed characters.
    const typed = this.state;
    if (text === ' ' || text === '-') this.run((s) => cmd.applyBlockInputRules(s, this.markdown));
    if (text.length === 1 && '*_`~'.includes(text)) this.run((s) => cmd.applyInlineInputRules(s));
    if (this.markdown.inline.length > 0) this.run((s) => cmd.applyTokenInputRules(s, this.markdown.inline) ?? s);
    if (text === ' ' && this.markdown.autolinks) this.run((s) => cmd.applyAutolinkInputRule(s) ?? s);
    this.shortcut = this.state.doc !== typed.doc ? { typed, applied: this.state } : null;
    if (!text.includes('\n')) this.typedForSuggestion();
  }

  /**
   * Backspace right after a Markdown shortcut, with no edit or caret move since,
   * restores the characters that were typed: `**a**` stays text. It is its
   * own undo step.
   */
  private undoShortcut(): boolean {
    const shortcut = this.shortcut;
    this.shortcut = null;
    // A caret move clears the shortcut (see onSelectionChange and onKeyDown); an edit replaces the document.
    const { doc, selection } = this.state;
    if (!shortcut || doc !== shortcut.applied.doc || !isCollapsed(selection)) return false;
    if (!samePosition(selection.focus, shortcut.applied.selection.focus)) return false;
    return this.run(() => shortcut.typed);
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
    this.imageToolbar?.hide();
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
    this.paint(this.redecoratePending);
    this.redecoratePending = false;
    this.afterRender();
    // Composed text opens a popup as typing does: a full-width slash opens the slash menu.
    if (composed) this.typedForSuggestion();
    if (this.pendingMode) this.setMode(this.pendingMode);
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
          : isTextless(block)
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
    // Moving the caret, even back to where it was, ends the chance to undo a shortcut with Backspace.
    if (CARET_KEY.test(e.key)) this.shortcut = null;
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
    const menu = this.blockMenu.isOpen ? this.blockMenu : (this.toolbar?.menu ?? null);
    if (menu) {
      // An open submenu takes the keys; ArrowLeft or Escape goes back to its menu.
      const sub = menu.submenu;
      if (sub) {
        if (e.key === 'ArrowLeft' || e.key === 'Escape') return handled(() => menu.closeSubmenu());
        if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) return handled(() => this.moveMenu(sub, 1));
        if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) return handled(() => this.moveMenu(sub, -1));
        if (e.key === 'Enter' && sub.count > 0) return handled(() => sub.pick());
      }
      if (e.key === 'ArrowRight' && menu.openSubmenu()) return handled(() => this.syncActiveDescendant());
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) return handled(() => this.moveMenu(menu, 1));
      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) return handled(() => this.moveMenu(menu, -1));
      if (e.key === 'Enter' && menu.count > 0) return handled(() => menu.pick());
      // Escape closes a toolbar menu and leaves the toolbar open.
      if (e.key === 'Escape') return handled(() => (menu === this.blockMenu ? this.closeBlockMenu() : this.toolbar!.closeMenu()));
    }

    if (e.key === 'Escape' && (this.toolbar?.isOpen || this.imageToolbar?.isOpen)) {
      return handled(() => {
        this.toolbarClosedFor = this.state.selection;
        this.toolbar?.hide();
        this.imageToolbar?.hide();
      });
    }
    if (this.readOnly) return;
    if (this.blockSel && this.onBlockKey(e)) {
      e.preventDefault();
      return;
    }

    // Enter on a selected image adds the line or paragraph after it, rather than replacing it.
    if (e.key === 'Enter' && !mod && !e.altKey) {
      this.refreshSelection();
      const image = cmd.selectedImage(this.state);
      if (image) {
        const after = { ...image.pos, offset: image.pos.offset + 1 };
        this.setSelection({ anchor: after, focus: after });
      }
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
      if (this.undoShortcut()) {
        e.preventDefault();
        return;
      }
      const { selection } = this.state;
      if (isCollapsed(selection) && selection.focus.offset === 0) {
        e.preventDefault();
        if (this.modeValue !== 'source') this.run(cmd.deleteBackward);
        return;
      }
    }

    if (mod && !e.altKey) {
      // Read the caret first: a click just before the key may not have reached selectionchange yet.
      if (e.key === '/' && !e.shiftKey) this.refreshSelection();
      if (e.key === '/' && !e.shiftKey && this.hasBlockMenu(this.state.selection.focus.blockId)) {
        return handled(() => this.openBlockMenu(this.state.selection.focus.blockId));
      }
      if (key === 'v' && e.shiftKey) {
        // The paste event that follows inserts plain text.
        this.plainPasteNext = true;
        return;
      }
    }
    if (e.key.startsWith('Arrow') && !mod && !e.shiftKey && !e.altKey && this.modeValue === 'rich') {
      this.refreshSelection();
      // Step into the source of a rendered block, or into a table, which the browser may skip.
      const into = this.blockPast(e.key);
      if (into) {
        e.preventDefault();
        this.setSelection({ anchor: into, focus: into });
        return;
      }
      // An image block is one stop: arrows select it, and the next arrow leaves it.
      const image = this.imageBlockStep(e.key);
      if (image) {
        e.preventDefault();
        if (image !== this.state.selection) this.setSelection(image);
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') this.run((s) => cmd.exitBlock(s, e.key === 'ArrowDown' ? 1 : -1));
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
      const key = { from, x: this.selectionRect()?.left ?? 0, vertical } as const;
      this.caretKey = key;
      if (vertical) this.unlessCaretMoves(key);
    }
  }

  /**
   * WebKit skips code blocks and tables with ArrowDown and ArrowUp. When no
   * editable text follows them (a rendered footnote or formula is not), it
   * does not move the caret at all. If the browser left the caret on the edge
   * line of its block, move it into the next block that holds a caret.
   */
  private unlessCaretMoves(key: { from: number; x: number; vertical: 0 | 1 | -1 }): void {
    const before = this.state.selection.focus;
    if (before.cell || !isCollapsed(this.state.selection)) return;
    const content = contentElement(this.renderer.elementFor(before.blockId) ?? this.root);
    if (!content || !this.onEdgeLine(content, key.vertical === 1)) return;
    setTimeout(() => {
      if (this.destroyed || this.caretKey !== key) return;
      const now = this.readDomSelection();
      if (!now || !samePosition(now.focus, before)) return;
      const blocks = this.state.doc.blocks;
      for (let i = key.from + key.vertical; i >= 0 && i < blocks.length; i += key.vertical) {
        const block = blocks[i]!;
        if (this.skipsCaret(block)) continue;
        this.caretKey = null;
        const row = key.vertical === 1 ? 0 : block.type === 'table' ? block.rows.length - 1 : 0;
        const pos: Position =
          block.type === 'table'
            ? { blockId: block.id, offset: key.vertical === 1 ? 0 : inlineLength(block.rows[row]![0]!), cell: { row, col: 0 } }
            : this.blockEntry(block, key.vertical === 1, key.x);
        this.setSelection({ anchor: pos, focus: pos });
        this.scrollCaretIntoView();
        return;
      }
      // Past the last line of a collapsible section that ends the document: add a paragraph after it.
      if (key.vertical === 1 && blocks[blocks.length - 1]!.type === 'detailsEnd') {
        this.caretKey = null;
        this.run((s) => cmd.appendParagraph(s));
      }
    });
  }

  /** Selects all the text of the block (or table cell) holding `target`. False if it holds none. */
  private selectBlockText(target: HTMLElement): boolean {
    const blockEl = target.closest?.<HTMLElement>(`[${BLOCK_ATTR}]`);
    if (!blockEl || !this.root.contains(blockEl)) return false;
    const block = getBlock(this.state.doc, blockEl.getAttribute(BLOCK_ATTR)!);
    const cellEl = target.closest<HTMLElement>('[data-row]');
    const cell = block.type === 'table' && cellEl ? { row: Number(cellEl.dataset.row), col: Number(cellEl.dataset.col) } : undefined;
    const content = containerContent(block, cell);
    if (!content || blockEl.classList.contains('mbe-view-block')) return false;
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
    // The copy button of a code block keeps the caret and the focus where they are.
    if (target.closest?.('.mbe-code-copy')) {
      e.preventDefault();
      return;
    }
    // A section's toggle collapses or expands it, while editing and read-only alike.
    const toggle = e.button === 0 ? target.closest?.<HTMLElement>('.mbe-details-toggle') : null;
    const toggleBlock = toggle?.closest<HTMLElement>(`[${BLOCK_ATTR}]`)?.getAttribute(BLOCK_ATTR);
    if (toggleBlock && this.root.contains(toggle!)) {
      e.preventDefault();
      this.setSectionCollapsed(toggleBlock, !this.collapsed.has(toggleBlock));
      return;
    }
    this.dropBlockSelection();
    if (target === this.root && e.button === 0 && !this.readOnly && this.modeValue === 'rich' && this.clickBelowLastBlock(e)) return;
    // Clicking an image selects it as one unit; Shift+click extends the text selection as usual.
    const imageEl = e.button === 0 && !e.shiftKey && !this.readOnly ? target.closest?.<HTMLElement>('.mbe-image') : null;
    const image = imageEl && this.root.contains(imageEl) ? this.imageTarget(imageEl) : null;
    if (image) {
      e.preventDefault();
      this.selectImageAt(image.pos);
      return;
    }
    const view = e.button === 0 && !this.readOnly ? target.closest?.<HTMLElement>('.mbe-view, .mbe-view-block') : null;
    if (view && this.root.contains(view)) {
      e.preventDefault();
      this.revealView(view);
      return;
    }
    // A triple click selects the text of one block (or cell), not the line break after it,
    // so typing replaces that block instead of joining it with the next.
    if (e.button === 0 && e.detail === 3 && !this.readOnly && this.modeValue === 'rich' && this.selectBlockText(target)) {
      e.preventDefault();
      return;
    }
    // Clicking a callout's icon opens its type menu.
    const icon = e.button === 0 && !this.readOnly ? target.closest?.<HTMLElement>('.mbe-callout-icon') : null;
    const iconBlock = icon?.parentElement?.getAttribute(BLOCK_ATTR);
    if (icon && iconBlock && icon.parentElement!.parentElement === this.root) {
      e.preventDefault();
      this.openBlockMenu(iconBlock, icon.getBoundingClientRect());
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
   * A click in the empty space below a final code block, table, divider or image block
   * adds a paragraph there. The browser would put the caret inside the
   * block, or in the block above a table.
   */
  private clickBelowLastBlock(e: MouseEvent): boolean {
    const blocks = this.state.doc.blocks;
    const last = blocks[blocks.length - 1];
    const image = last ? imageBlockOffset(last) : null;
    if (!last || (last.type !== 'code' && last.type !== 'table' && !isTextless(last) && image === null)) return false;
    const el = this.root.querySelector<HTMLElement>(`:scope > [data-block-id="${last.id}"]`);
    if (!el || e.clientY <= el.getBoundingClientRect().bottom) return false;
    e.preventDefault();
    this.root.focus({ preventScroll: true });
    const end = endOf(last);
    const selection = image !== null ? { anchor: { blockId: last.id, offset: image }, focus: { blockId: last.id, offset: image + 1 } } : { anchor: end, focus: end };
    this.run((s) => cmd.exitBlock({ ...s, selection }, 1));
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
    const copy = target.closest?.<HTMLElement>('.mbe-code-copy');
    if (copy) {
      e.preventDefault();
      this.copyCode(copy);
      return;
    }
    const link = target.closest?.<HTMLAnchorElement>('a.mbe-link');
    if (!link) return;
    // Links open on click when read-only, and on Mod+click while editing.
    e.preventDefault();
    // The rendered href is the resolved URL; a link the policy dropped has none.
    if (this.readOnly || (isMac ? e.metaKey : e.ctrlKey)) this.openHref(link.getAttribute('href'), e);
  }

  /** Opens a resolved link URL, as a click on a link does: through `onLinkClick`, else in a new tab. */
  private openHref(href: string | null, event: MouseEvent): void {
    if (!href || this.runtime.onLinkClick?.({ editor: this, href, event })) return;
    this.root.ownerDocument.defaultView?.open(href, '_blank', 'noopener,noreferrer');
  }

  /** Copies the code of the code block holding `button`, and shows that it did for a moment. */
  private copyCode(button: HTMLElement): void {
    const blockEl = button.closest<HTMLElement>(`[${BLOCK_ATTR}]`);
    const block = blockEl && this.state.doc.blocks.find((b) => b.id === blockEl.getAttribute(BLOCK_ATTR));
    // A code block inside a rendered HTML section is not a block of the document: copy what it shows.
    const text =
      block?.type === 'code' ? inlineText(block.content) : button.closest('.mbe-flow .mbe-code')?.querySelector('code')?.textContent;
    if (text == null) return;
    const doc = this.root.ownerDocument;
    const show = (name: 'copyCode' | 'copied') => {
      const icon = iconNode(doc, this.icon(name));
      button.replaceChildren(...(icon ? [icon] : []));
      button.setAttribute('aria-label', this.labels[name]);
      button.title = this.labels[name];
      button.classList.toggle('mbe-copied', name === 'copied');
    };
    const done = () => {
      show('copied');
      setTimeout(() => button.isConnected && show('copyCode'), 1500);
    };
    // Without the async clipboard (an insecure origin), copy through a selected textarea.
    const fallback = () => {
      const area = doc.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      doc.body.appendChild(area);
      area.select();
      const ok = doc.execCommand('copy');
      area.remove();
      this.syncDomSelection(this.hasFocus());
      if (ok) done();
    };
    const clipboard = doc.defaultView?.navigator.clipboard;
    if (clipboard?.writeText) clipboard.writeText(text).then(done, fallback);
    else fallback();
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
    if (next && (this.root.contains(next) || this.inputPopover.contains(next))) return;
    // Focus may move between table cells and the root; check after it settles.
    queueMicrotask(() => {
      if (this.hasFocus() || this.inputPopover.isOpen) return;
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
    this.blockHandle.hide();
    this.linkCard?.reposition();
    this.resizeHandles.reposition();
    if (this.suggestions.isActive || this.toolbar?.isOpen || this.imageToolbar?.isOpen || this.blockMenu.isOpen) this.updateUi();
  }

  // -------------------------------------------------------------------------
  // Clipboard

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (this.fromControl(e)) return;
    if (this.modeValue === 'source') {
      // The selected text, as it is.
      this.refreshSelection();
      if (isCollapsed(this.state.selection) || !e.clipboardData) return;
      e.preventDefault();
      const { from, to } = src.sourceRange(this.state);
      e.clipboardData.setData('text/plain', sourceText(this.state.doc).slice(from, to));
      if (cut && !this.readOnly) this.run((s) => src.insertSourceText(s, ''));
      return;
    }
    const range = this.blockRange();
    if (range) {
      // Whole blocks, even an empty one.
      if (!e.clipboardData) return;
      e.preventDefault();
      const doc: Doc = { blocks: cmd.closeSections(this.state.doc.blocks.slice(range.from, range.to + 1).map(cmd.cloneBlock)) };
      // serializeBlocks keeps a selected empty line, which serializeMarkdown drops at the end.
      writeClipboard(e.clipboardData, doc, serializeBlocks(doc.blocks, this.markdown));
      if (cut && !this.readOnly) this.deleteSelectedBlocks();
      return;
    }
    this.refreshSelection();
    if (isCollapsed(this.state.selection) || !e.clipboardData) return;
    e.preventDefault();
    const selected = cmd.selectedBlocks(this.state);
    const doc: Doc = { blocks: cmd.closeSections(selected) };
    const markdown = serializeMarkdown(doc, this.markdown).replace(/\n$/, '');
    // Text selected inside one code or raw block is copied as written, so it
    // pastes into a terminal or another code block as code; the Markdown,
    // with its escapes, travels with the HTML for a paste into a paragraph.
    const only = selected.length === 1 && selected[0]!.type === 'paragraph' ? selected[0] : null;
    const code = only && isPlainTextBlock(getBlock(this.state.doc, this.state.selection.focus.blockId));
    writeClipboard(e.clipboardData, doc, markdown, code ? inlineText(only.content) : markdown);
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
    // Markdown copied from a code editor comes with HTML that only colors its
    // source (VS Code also adds its own type): the text is read as Markdown.
    const rich = data.getData('text/html');
    const html = data.types.includes('vscode-editor-data') || isStyledText(rich) ? '' : rich;
    const plainOnly = this.plainPasteNext;
    this.plainPasteNext = false;
    if (this.modeValue === 'source') {
      // Plain text only.
      if (text) this.run((s) => src.insertSourceText(s, text.replace(/\r\n?/g, '\n')));
      return;
    }

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
    if (this.modeValue === 'source') {
      this.focus();
      this.run((s) => src.insertSourceAt(s, position.offset, text.replace(/\r\n?/g, '\n'), false, false));
      return;
    }
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
      // Without callouts or sections in the Markdown dialect, they would not read back as such.
      .filter((b): b is BlockItem => !!b && (b.id !== 'callout' || this.markdown.callouts) && (b.id !== 'details' || this.markdown.details))
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
    if (a < 0 || h < 0) return null;
    return this.wholeSections({ from: Math.min(a, h), to: Math.max(a, h) });
  }

  /** `range` grown so that a collapsible section with its title or its end in it is in it whole. */
  private wholeSections(range: cmd.BlockRange): cmd.BlockRange {
    const blocks = this.current.doc.blocks;
    let { from, to } = range;
    if (!blocks.some((b) => b.type === 'details')) return range;
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = from; i <= to; i++) {
        const block = blocks[i]!;
        if (block.type === 'details') {
          const end = cmd.sectionEnd(blocks, i) ?? i;
          if (end > to) (to = end), (changed = true);
        } else if (block.type === 'detailsEnd') {
          const title = cmd.sectionTitle(blocks, i);
          if (title !== null && title < from) (from = title), (changed = true);
        }
      }
    }
    return { from, to };
  }

  /** The next block a block selection moves to from `index`: blocks shown on screen, not section ends. */
  private nextSelectable(index: number, dir: 1 | -1): string {
    const blocks = this.current.doc.blocks;
    for (let i = index + dir; i >= 0 && i < blocks.length; i += dir) {
      const block = blocks[i]!;
      if (block.type !== 'detailsEnd' && !this.renderer.elementFor(block.id)?.hasAttribute('data-section-hidden')) return block.id;
    }
    return blocks[index]!.id;
  }

  /** Selects whole blocks, from the block `anchor` to the block `head`. */
  private selectBlockRange(anchor: string, head: string): void {
    this.blockSel = { anchor, head };
    this.current = { ...this.current, selection: cmd.spanBlocks(this.current.doc.blocks, this.blockRange()!), storedMarks: null };
    this.history.breakGroup();
    this.suggestions.close();
    this.toolbar?.hide();
    this.imageToolbar?.hide();
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
          // From a section title, moving down passes over the section.
          let head = blockIndex(this.current.doc, this.blockSel!.head);
          if (!up && blocks[head]?.type === 'details') head = cmd.sectionEnd(blocks, head) ?? head;
          this.selectBlockRange(this.blockSel!.anchor, this.nextSelectable(head, up ? -1 : 1));
        } else {
          const id = this.nextSelectable(up ? range.from : range.to, up ? -1 : 1);
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
    const cell = this.state.selection.focus.cell;
    if (block.type === 'table' && this.state.selection.focus.blockId === blockId && cell) {
      const items: MenuItem[] = TABLE_ACTIONS.map(({ id, action }) => ({
        id,
        label: this.labels[id],
        icon: this.icon(id),
        run: () => this.run((s) => cmd.tableAction(s, action)),
      }));
      // A column without an alignment shows as left-aligned.
      const current = block.align[cell.col] ?? 'left';
      items.splice(4, 0, this.alignMenuItem('align', current, (align) => ({
        icon: this.icon(align.id),
        run: () => this.run((s) => cmd.tableAction(s, { kind: 'align', align: align.align })),
      })));
      sections.push({ title: this.labels.tableSection, items });
    }
    const kind = quoteKind(block);
    if (kind && kind !== 'quote') {
      // The callout's types, with the current one checked, and Delete for the whole callout.
      // No Duplicate: a copy right after it would join it.
      const current = kind;
      const items: MenuItem[] = CALLOUT_TYPES.map((type) => {
        const name = calloutName(type);
        return {
          id: name,
          label: this.labels[name],
          icon: this.icon(name),
          checked: type === current,
          run: () => this.run((s) => cmd.setCallout(s, blockId, type)),
        };
      });
      sections.push({ title: this.labels.callout, items });
      sections.push({
        items: [
          {
            id: 'delete',
            label: this.labels.delete,
            icon: this.icon('delete'),
            danger: true,
            run: () =>
              this.run((s) => {
                const run = cmd.quoteRun(s, blockId);
                return run ? cmd.deleteBlocks(s, { from: run.start, to: run.end }) : null;
              }),
          },
        ],
      });
      return sections;
    }
    const imageOffset = imageBlockOffset(block);
    if (imageOffset !== null) {
      const pos: Position = { blockId, offset: imageOffset };
      const image = sliceInline((block as ParagraphBlock).content, imageOffset, imageOffset + 1)[0]!.image!;
      const items: MenuItem[] = [
        this.alignMenuItem('imageAlignLeft', image.align ?? 'left', (align) => ({
          icon: this.icon(align.image),
          // An image without an alignment sits on the left, so Left removes the word.
          run: () => this.updateImageAt(pos, { align: align.align === 'left' ? null : align.align }),
        })),
        { id: 'altText', label: this.labels.altText, icon: this.icon('altText'), run: () => this.editAltText(pos, image.alt) },
      ];
      if (image.width) {
        items.push({
          id: 'resetImageSize',
          label: this.labels.resetImageSize,
          icon: this.icon('resetImageSize'),
          run: () => this.updateImageAt(pos, { width: null }),
        });
      }
      sections.push({ title: this.labels.imageSection, items });
    }
    sections.push({
      items: [
        { id: 'duplicate', label: this.labels.duplicate, icon: this.icon('duplicate'), run: () => this.run((s) => cmd.duplicateBlock(s, blockId)) },
        { id: 'delete', label: this.labels.delete, icon: this.icon('delete'), danger: true, run: () => this.run((s) => cmd.deleteBlock(s, blockId)) },
      ],
    });
    return sections;
  }

  /** The Align row of the block menu: a submenu of Left, Center and Right with the current one checked. */
  private alignMenuItem(
    icon: IconName,
    current: 'left' | 'center' | 'right',
    choice: (align: (typeof ALIGN_CHOICES)[number]) => Pick<MenuItem, 'icon' | 'run'>,
  ): MenuItem {
    return {
      id: 'align',
      label: this.labels.align,
      icon: this.icon(icon),
      run: () => {},
      submenu: {
        title: this.labels.align,
        items: ALIGN_CHOICES.map((align) => ({ id: align.id, label: this.labels[align.id], checked: current === align.align, ...choice(align) })),
      },
    };
  }

  /**
   * @internal
   * Only large blocks get the block handle and block menu: tables, code blocks,
   * image blocks and callouts. Other blocks change type through the slash menu
   * or Markdown shortcuts.
   */
  hasBlockMenu(blockId: string): boolean {
    if (this.modeValue === 'source') return false;
    const block = this.state.doc.blocks.find((b) => b.id === blockId);
    return block?.type === 'table' || block?.type === 'code' || isCallout(block) || (!!block && isImageBlock(block));
  }

  /**
   * @internal
   * The block whose block menu `blockId` belongs to, or null when it has none:
   * the first block of a callout, so the handle sits by its icon; otherwise
   * the block itself.
   */
  blockMenuOwner(blockId: string): string | null {
    if (!this.hasBlockMenu(blockId)) return null;
    const run = cmd.quoteRun(this.state, blockId);
    return run ? this.state.doc.blocks[run.start]!.id : blockId;
  }

  /** @internal Opens the block menu of a table, code block, image block or callout, as the block handle and Mod+/ do. */
  openBlockMenu(blockId: string, anchor?: DOMRect): void {
    if (this.readOnly || !this.hasBlockMenu(blockId)) return;
    this.dropBlockSelection();
    this.suggestions.close();
    this.toolbar?.hide();
    this.imageToolbar?.hide();
    // Keep the caret in the table cell for table actions; select the image of an image block;
    // otherwise move the caret into the block. Either way the editor takes focus, so the menu's
    // keys work and a press outside closes it.
    const imageOffset = imageBlockOffset(getBlock(this.state.doc, blockId));
    if (imageOffset !== null) {
      this.current = cmd.selectImage(this.state, { blockId, offset: imageOffset });
      if (!this.hasFocus()) this.focus();
    } else if (this.state.selection.focus.blockId !== blockId && !this.inSameCallout(this.state.selection.focus.blockId, blockId)) {
      const block = getBlock(this.state.doc, blockId);
      const start = startOf(block);
      this.current = { ...this.state, selection: { anchor: start, focus: start } };
      this.focus();
    } else if (!this.hasFocus()) {
      this.focus();
    }
    this.blockMenu.setSections(this.blockMenuSections(blockId));
    const rect = anchor ?? this.blockElement(blockId)?.getBoundingClientRect();
    if (rect) this.blockMenu.popup.show(rect, 'below');
    this.syncActiveDescendant();
  }

  /** True if the blocks `a` and `b` are in the same callout. */
  private inSameCallout(a: string, b: string): boolean {
    const block = getBlock(this.state.doc, b);
    const run = isCallout(block) ? cmd.quoteRun(this.state, b) : null;
    if (!run) return false;
    const i = blockIndex(this.state.doc, a);
    return i >= run.start && i <= run.end;
  }

  private closeBlockMenu(): void {
    this.blockMenu.hide();
    // The image toolbar, hidden behind the menu, comes back.
    this.updateUi();
  }

  /**
   * A press anywhere but the block menu or the block handle closes the block menu,
   * in the editor's text too. The same goes for a toolbar menu and the toolbar.
   */
  private onDocumentPointerDown(e: Event): void {
    const target = e.target as Node | null;
    if (this.toolbar?.menu && !(target && this.toolbar.contains(target))) this.toolbar.closeMenu();
    if (!this.blockMenu.isOpen) return;
    if (target && (this.blockMenu.contains(target) || this.blockHandle.contains(target))) return;
    this.closeBlockMenu();
  }

  // -------------------------------------------------------------------------
  // Toolbar and link popover (see ui/toolbar.ts)

  /**
   * @internal Opens the link popover for the selection, as Mod+K does. Returns
   * false when there is nothing to link: no selected text and no link at the caret.
   */
  openLinkPopover(): boolean {
    if (this.readOnly) return false;
    if (this.modeValue === 'source') return false;
    const block = getBlock(this.state.doc, this.state.selection.focus.blockId);
    if (isPlainTextBlock(block)) return false;
    if (isCollapsed(this.state.selection) && !cmd.activeLink(this.state)) return false;
    const rect = this.selectionRect();
    if (!rect) return false;
    this.toolbar?.hide();
    const saved = this.state.selection;
    const value = cmd.activeLink(this.current)?.href ?? '';
    const { labels } = this;
    const options = { value, label: labels.link, placeholder: labels.linkPlaceholder, type: 'url', removeLabel: labels.removeLink } as const;
    this.inputPopover.open(rect, options, (href) => {
      this.current = { ...this.state, selection: saved };
      if (href !== null) this.run((s) => cmd.setLink(s, href === '' ? null : href));
      this.focus();
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // UI that follows the selection

  private updateUi(): void {
    if (this.destroyed) return;
    this.expandAroundSelection();
    const focused = this.hasFocus();

    // Slash hint in the empty paragraph that has the caret, when the app asks for it.
    const pos = this.state.selection.focus;
    const el = focused && !this.blockSel && isCollapsed(this.state.selection) ? this.renderer.elementFor(pos.blockId) : undefined;
    // The placeholder of an empty document takes precedence over the slash hint.
    const placeholderShown = !!this.options.placeholder && this.state.doc.blocks.length === 1;
    const slashHint = !!this.options.slashHint && this.options.slashMenu !== false;
    const showHint =
      slashHint && el && el.classList.contains('mbe-paragraph') && el.classList.contains('mbe-empty') && !this.readOnly && !placeholderShown;
    const nextHint = showHint ? el : null;
    if (this.hintEl !== nextHint) {
      this.hintEl?.classList.remove('mbe-show-hint');
      nextHint?.classList.add('mbe-show-hint');
      this.hintEl = nextHint;
    }

    this.suggestions.update(focused);

    // The selected image: an outline, its handles and its toolbar.
    const image = focused && !this.readOnly && !this.blockSel ? this.imageTargetAt(this.state) : null;
    this.paintSelectedImage(image?.el ?? null);
    this.resizeHandles.update(image);

    // A toolbar closed with Escape stays closed for that selection.
    const closed = this.toolbarClosedFor;
    if (closed && !(samePosition(closed.anchor, this.state.selection.anchor) && samePosition(closed.focus, pos))) this.toolbarClosedFor = null;

    // Image toolbar, over the selected image.
    if (this.imageToolbar) {
      const show =
        image &&
        !this.toolbarClosedFor &&
        !this.composing &&
        !this.suggestions.isActive &&
        !this.blockMenu.isOpen &&
        !this.inputPopover.isOpen &&
        !this.resizeHandles.isDragging;
      if (show) this.imageToolbar.show(image, cmd.selectedImageBlock(this.state) !== null);
      else this.imageToolbar.hide();
    }

    // Formatting toolbar.
    if (this.toolbar) {
      const block = this.state.doc.blocks.find((b) => b.id === pos.blockId);
      const show =
        !this.toolbarClosedFor &&
        focused &&
        !this.readOnly &&
        !this.composing &&
        !isCollapsed(this.state.selection) &&
        !this.blockSel &&
        !image &&
        !this.suggestions.isActive &&
        !this.blockMenu.isOpen &&
        !!block &&
        !isPlainTextBlock(block) &&
        block.type !== 'divider';
      if (show) this.toolbar.show();
      else this.toolbar.hide();
    }
    // On touch devices there is no hover, so the block handle follows the caret.
    if (focused && !this.readOnly && isTouch()) {
      const owner = this.blockMenuOwner(pos.blockId);
      if (owner) this.blockHandle.showFor(owner);
      else this.blockHandle.hide();
    }
    if (!focused && this.blockMenu.isOpen && !this.root.ownerDocument.activeElement?.closest?.('.mbe-ui')) this.blockMenu.hide();
    if (this.linkCard) {
      if (this.readOnly) this.linkCard.hide();
      else this.linkCard.setCaret(focused && !this.composing && !this.blockSel && !this.suggestions.isActive && !this.blockMenu.isOpen && !this.inputPopover.isOpen ? this.caretLink() : null);
    }
    this.syncActiveDescendant();
  }

  // -------------------------------------------------------------------------
  // Collapsible sections

  /**
   * Collapses or expands the collapsible section titled by the block
   * `blockId`. This changes the view only: the Markdown, history and events
   * stay as they are. A caret inside a section that collapses moves to the
   * end of its title. Returns false when the block is not a section title.
   */
  setSectionCollapsed(blockId: string, collapsed: boolean): boolean {
    if (this.destroyed) return false;
    const doc = this.state.doc;
    const index = blockIndex(doc, blockId);
    if (doc.blocks[index]?.type !== 'details') return false;
    if (this.collapsed.has(blockId) === collapsed) return true;
    if (collapsed) this.collapsed.add(blockId);
    else this.collapsed.delete(blockId);
    if (collapsed) {
      const end = cmd.sectionEnd(doc.blocks, index) ?? index;
      const inside = (p: Position) => {
        const i = blockIndex(doc, p.blockId);
        return i > index && i <= end;
      };
      const { anchor, focus } = this.state.selection;
      if (inside(anchor) || inside(focus)) {
        const title = endOf(doc.blocks[index]!);
        this.dropBlockSelection();
        this.current = { ...this.current, selection: { anchor: title, focus: title }, storedMarks: null };
        this.syncDomSelection();
      }
    }
    this.renderer.updateSections(doc);
    this.updateUi();
    return true;
  }

  /** True when the section titled by `blockId` is shown collapsed. */
  isSectionCollapsed(blockId: string): boolean {
    return this.collapsed.has(blockId);
  }

  /** Sections that are not saved open start collapsed, as a Markdown renderer shows them. */
  private collapseClosedSections(doc: Doc): void {
    for (const block of doc.blocks) if (block.type === 'details' && !block.open) this.collapsed.add(block.id);
  }

  /** Expands the collapsed sections around the selection's focus, so the caret is never hidden. */
  private expandAroundSelection(): void {
    if (this.collapsed.size === 0) return;
    const focusId = this.state.selection.focus.blockId;
    if (!this.renderer.elementFor(focusId)?.hasAttribute('data-section-hidden')) return;
    const titles: string[] = [];
    for (const block of this.state.doc.blocks) {
      if (block.id === focusId) break;
      if (block.type === 'details') titles.push(block.id);
      else if (block.type === 'detailsEnd') titles.pop();
    }
    for (const id of titles) this.collapsed.delete(id);
    this.renderer.updateSections(this.state.doc);
  }

  /** Blocks the caret passes over: dividers, section ends, and blocks inside a collapsed section. */
  private skipsCaret(block: Block): boolean {
    return isTextless(block) || !!this.renderer.elementFor(block.id)?.hasAttribute('data-section-hidden');
  }

  // -------------------------------------------------------------------------
  // Links (see ui/linkCard.ts)

  /** The link the caret is inside, not at its edge, with its element. */
  private caretLink(): LinkTarget | null {
    if (!isCollapsed(this.state.selection)) return null;
    const link = cmd.activeLink(this.state);
    if (!link || link.pos.offset <= link.from || link.pos.offset >= link.to) return null;
    const blockEl = this.renderer.elementFor(link.pos.blockId);
    if (!blockEl) return null;
    const start = { ...link.pos, offset: link.from };
    for (const el of blockEl.querySelectorAll<HTMLAnchorElement>('a.mbe-link')) {
      const pos = this.linkStart(el);
      if (pos && samePosition(pos, start)) return this.linkTargetOf(el);
    }
    return null;
  }

  /** The document position where a rendered link starts. */
  private linkStart(el: HTMLAnchorElement): Position | null {
    return domToPosition(this.root, el, 0);
  }

  /** The link a rendered link element shows, or null for one outside the document's blocks. */
  private linkTargetOf(el: HTMLAnchorElement): LinkTarget | null {
    if (el.closest('.mbe-flow')) return null;
    const pos = this.linkStart(el);
    if (!pos) return null;
    const block = this.state.doc.blocks.find((b) => b.id === pos.blockId);
    const content = block && containerContent(block, pos.cell);
    const link = content && linkAt(content, pos.offset);
    return link && link.from === pos.offset ? { el, href: link.href } : null;
  }

  /** The selection of a link's whole text, from a rendered link element. */
  private linkSelection(target: LinkTarget): Selection | null {
    const from = this.linkStart(target.el);
    if (!from) return null;
    const block = getBlock(this.state.doc, from.blockId);
    const content = containerContent(block, from.cell);
    const link = content && linkAt(content, from.offset);
    return link ? { anchor: from, focus: { ...from, offset: link.to } } : null;
  }

  /** Opens the link popover for a link, as Mod+K does with the caret in it. */
  private editLink(target: LinkTarget): void {
    const range = this.linkSelection(target);
    if (!range || this.readOnly) return;
    this.focus();
    this.setSelection(range);
    this.openLinkPopover();
  }

  /** Removes a link and keeps its text, as one undo step. */
  private removeLink(target: LinkTarget): void {
    const range = this.linkSelection(target);
    if (!range || this.readOnly) return;
    this.run((s) => ({ ...cmd.setLink({ ...s, selection: range }, null), selection: s.selection }));
  }

  /** Marks the selected image's element, and hides the browser's selection highlight over it. */
  private paintSelectedImage(el: HTMLElement | null): void {
    if (this.selectedImageEl !== el) {
      this.selectedImageEl?.classList.remove('mbe-image-selected');
      el?.classList.add('mbe-image-selected');
      this.selectedImageEl = el;
    }
    this.root.classList.toggle('mbe-image-selection', el !== null);
  }

  // -------------------------------------------------------------------------
  // Images (see ui/resizeHandles.ts)

  /** The selected image of `state` and its element, or null. */
  private imageTargetAt(state: EditorState): ImageTarget | null {
    const selected = cmd.selectedImage(state);
    if (!selected) return null;
    const blockEl = this.renderer.elementFor(selected.pos.blockId);
    const el = blockEl ? atomAt(blockEl, selected.pos) : null;
    if (!el?.classList.contains('mbe-image')) return null;
    return { el, ...selected };
  }

  /** @internal The image an element shows, and the position before it. Null when it is not an image in this editor. */
  imageTarget(el: HTMLElement): ImageTarget | null {
    if (!el.parentNode || !this.root.contains(el)) return null;
    const pos = domToPosition(this.root, el.parentNode, childIndex(el));
    if (!pos) return null;
    const next = cmd.selectImage(this.current, pos);
    const selected = next === this.current ? null : cmd.selectedImage(next);
    return selected ? { el, ...selected } : null;
  }

  /** @internal Selects the image after `pos` and focuses the editor. */
  selectImageAt(pos: Position): void {
    if (this.readOnly || this.destroyed) return;
    const next = cmd.selectImage(this.current, pos);
    if (next === this.current) return;
    if (!this.hasFocus()) this.root.focus({ preventScroll: true });
    this.setSelection(next.selection);
  }

  /** @internal Changes the image after `pos` and selects it, as one undo step. */
  updateImageAt(pos: Position, change: cmd.ImageChange): void {
    this.run((s) => cmd.updateImage(s, pos, change));
  }

  /**
   * @internal
   * Opens the alt text field under the image after `pos`. Enter saves the text,
   * Escape keeps the old one. Either way the image stays selected.
   */
  editAltText(pos: Position, alt: string): void {
    // Opening the block menu or the image toolbar selected the image.
    const rect = (this.imageTargetAt(this.state)?.el ?? this.blockElement(pos.blockId))?.getBoundingClientRect();
    if (!rect) return;
    this.imageToolbar?.hide();
    const { labels } = this;
    const options = { value: alt, label: labels.altText, placeholder: labels.altTextPlaceholder, type: 'text' } as const;
    this.inputPopover.open(rect, options, (value) => {
      if (value !== null) this.updateImageAt(pos, { alt: value });
      else this.current = cmd.selectImage(this.state, pos);
      this.focus();
    });
  }

  /**
   * @internal
   * Deletes the image after `pos`: the whole block of an image block, as
   * Backspace on the selected image does, else the image alone.
   */
  deleteImageAt(pos: Position): void {
    this.run((s) => {
      const selected = cmd.selectImage(s, pos);
      if (selected === s) return null;
      return cmd.selectedImageBlock(selected) ? cmd.deleteBlock(selected, pos.blockId) : cmd.deleteSelection(selected);
    });
  }

  /** @internal Shows the resize handles again, after a resize that changed nothing. */
  refreshImageUi(): void {
    this.updateUi();
  }

  private syncActiveDescendant(): void {
    const menu = this.blockMenu.isOpen ? this.blockMenu : this.toolbar?.menu;
    const id = this.suggestions.activeDescendant ?? menu?.activeDescendant ?? null;
    if (id) this.root.setAttribute('aria-activedescendant', id);
    else this.root.removeAttribute('aria-activedescendant');
  }

  private hideUi(): void {
    this.dropBlockSelection();
    this.suggestions.close();
    this.blockMenu.hide();
    this.toolbar?.hide();
    this.imageToolbar?.hide();
    this.blockHandle.hide();
    this.linkCard?.setCaret(null);
    this.resizeHandles.hide();
    this.paintSelectedImage(null);
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

/** True for a part of a callout: a paragraph or a list item. */
function isCallout(block: Block | undefined): boolean {
  const kind = quoteKind(block);
  return kind !== null && kind !== 'quote';
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
    case 'detailsEnd':
      return 'details';
    default:
      return block.type;
  }
}

/**
 * Writes blocks to the clipboard as Markdown and as HTML that carries the
 * Markdown, so pasting into an editor is lossless. `plain` is the `text/plain`
 * flavour when it should differ from the Markdown, as for code.
 */
function writeClipboard(data: DataTransfer, doc: Doc, markdown: string, plain = markdown): void {
  data.setData('text/plain', plain);
  data.setData('text/html', `<meta charset="utf-8"><div data-mbe-markdown="${encodeURIComponent(markdown)}">${docToHtml(doc)}</div>`);
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

/** Scrolls the nearest scrolling ancestor of `el` (or the window) by `dy` pixels. */
function scrollBy(el: HTMLElement, dy: number): void {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
      node.scrollTop += dy;
      return;
    }
  }
  el.ownerDocument.defaultView?.scrollBy(0, dy);
}
