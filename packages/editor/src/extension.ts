// Extensions add behavior to the editor: Markdown syntax, key bindings,
// decorations, and hooks into paste, drop and creation. An extension is a
// plain object; built-in factories such as `math()` return one.

import type { Decoration, Decorator } from './decorations';
import type { Editor } from './editor';
import type { SuggestionConfig } from './extensions/suggestion';
import type { MarkdownSyntax } from './markdown/options';
import type { CodeBlock, Position } from './model';
import type { ThemeClasses } from './theme';

export interface ExtensionContext {
  readonly editor: Editor;
}

/**
 * Handles a key. Return true to stop: no later binding runs and the browser
 * default is prevented.
 */
export type KeyHandler = (ctx: ExtensionContext) => boolean;

/**
 * Renders the Markdown source of a token (`kind` is `inline`, `element` a
 * span), a raw block, or the code of a code block (`block`, a div) into
 * `element`. Returns false, or throws, to show the source instead. Results
 * are cached by source, so the output must depend on nothing else; what a
 * view reads from the editor instead (its font, for a layout that measures
 * text) is current again after `editor.refreshViews()`, which the editor
 * calls itself when the theme's font tokens change.
 *
 * `element` is not in the page yet, so it has no layout. A view that
 * measures text uses the editor: `getComputedStyle(ctx.editor.root)` gives
 * the font the view's text will have, for a canvas `measureText`.
 *
 * A view that finishes later (a diagram, a renderer that loads on demand)
 * fills in what it can at once and returns a promise: the editor shows that
 * meanwhile, and the finished element when the promise resolves. A promise
 * that rejects or resolves to false shows the source.
 */
export type SyntaxView = (source: string, element: HTMLElement, kind: 'inline' | 'block', ctx: ExtensionContext) => void | false | PromiseLike<void | false>;

/** A code block's code, for decorations such as syntax highlighting. */
export interface CodeDecorationContext {
  readonly block: CodeBlock;
  /** The code. */
  readonly text: string;
  /** The info string's language, as written; empty for none. */
  readonly language: string;
}

export interface Extension {
  /** Unique name, for debugging and for replacing a built-in extension. */
  readonly name: string;
  /** Markdown syntax this extension adds. */
  readonly markdown?: MarkdownSyntax;
  /**
   * Key bindings, with ProseMirror key names: modifiers `Mod-` (Cmd on
   * macOS, Ctrl elsewhere), `Ctrl-`, `Alt-`, `Shift-`, `Meta-`, then a key
   * such as `b`, `7`, `Enter`, `Tab` or `Escape`.
   */
  readonly keymap?: Readonly<Record<string, KeyHandler>>;
  /**
   * Classes on ranges of text, for each paragraph, heading, list item,
   * quote and table cell. Recomputed only for blocks that changed. Never saved.
   */
  readonly decorations?: Decorator;
  /** A popup menu opened by a trigger character. See `suggestion()`. */
  readonly suggestion?: SuggestionConfig;
  /** Called on paste before the editor's own handling. Return true to stop it. */
  readonly handlePaste?: (ctx: ExtensionContext & { readonly event: ClipboardEvent }) => boolean;
  /**
   * Called on drop before the editor's own handling, with the document
   * position under the pointer (null outside text). Return true to stop it.
   */
  readonly handleDrop?: (ctx: ExtensionContext & { readonly event: DragEvent; readonly position: Position | null }) => boolean;
  /**
   * Classes on ranges of a code block's code, for syntax highlighting, in
   * editing and read-only alike. Recomputed only for code blocks that
   * changed; call `editor.redecorate()` when a language finishes loading.
   * Never saved.
   */
  readonly codeDecorations?: (ctx: CodeDecorationContext) => readonly Decoration[];
  /**
   * Shows tokens and raw blocks of a syntax rendered instead of as source,
   * keyed by syntax name; `math()` uses this to show formulas. `code:` and a
   * language (`code:mermaid`) renders code blocks of that language, such as
   * diagrams. While editing, a token shows its source when the caret touches
   * it, and a block when the selection is in it; clicking either does the
   * same. Read-only always shows the rendered view.
   */
  readonly views?: Readonly<Record<string, SyntaxView>>;
  /**
   * Theme classes for the elements this extension cares about, such as
   * `token.math`. The editor's `theme` wins for the same key, and an earlier
   * extension wins over a later one.
   */
  readonly theme?: { readonly classes?: ThemeClasses };
  /** Called once when the editor is created. May return a cleanup function, called on destroy. */
  readonly onCreate?: (ctx: ExtensionContext) => void | (() => void);
}
