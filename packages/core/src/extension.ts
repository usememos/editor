// Extensions add behavior to the editor: Markdown syntax, key bindings,
// decorations, and hooks into paste, drop and creation. An extension is a
// plain object; built-in factories such as `math()` return one.

import type { Decorator } from './decorations';
import type { Editor } from './editor';
import type { SuggestionConfig } from './extensions/suggestion';
import type { MarkdownSyntax } from './markdown/options';
import type { Position } from './model';

export interface ExtensionContext {
  readonly editor: Editor;
}

/**
 * Handles a key. Return true to stop: no later binding runs and the browser
 * default is prevented.
 */
export type KeyHandler = (ctx: ExtensionContext) => boolean;

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
  /** Called once when the editor is created. May return a cleanup function, called on destroy. */
  readonly onCreate?: (ctx: ExtensionContext) => void | (() => void);
}
