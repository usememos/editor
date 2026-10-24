// suggestion: an autocomplete popup at the caret, opened by typing a
// trigger such as "#", "@" or "[[". The editor implements the behavior
// (when it opens, keys, placement, IME); the caller decides the syntax: the
// triggers, what counts as a token (`match`), where the popup may open
// (`allow`), the items, and what a pick writes (`command`). The editor's
// slash menu is built on it.

import type { Editor } from '../editor';
import type { Extension } from '../extension';
import type { Icon } from '../icons';
import type { Block, Cell, Inline, Position } from '../model';
import type { EditorMode } from '../sourceMode';

export interface SuggestionItem {
  /** Stable ID, for tests and keys. Defaults to the label. */
  readonly id?: string;
  readonly label: string;
  /** Secondary text after the label, such as a user name or a path. */
  readonly detail?: string;
  /** Shown before the label: text, or an element (such as an `<svg>` or an avatar `<img>`) that is cloned. */
  readonly icon?: Icon;
  /** A group heading. Items with the same section should be next to each other; a heading starts where it changes. */
  readonly section?: string;
  /** Written after the trigger by the default command. Default `id`, then `label`. */
  readonly value?: string;
}

export interface SuggestionRange {
  /** The start of the trigger. */
  readonly from: Position;
  /** The end of the token, which may be after the caret. */
  readonly to: Position;
}

/** A token at the caret, as offsets into the block's or cell's text. */
export interface SuggestionMatch {
  /** The start of the trigger. */
  readonly from: number;
  /** The end of the token. At or after the caret. */
  readonly to: number;
  /** What `items` receives. The built-in matchers return the text between the trigger and the caret. */
  readonly query: string;
}

export interface SuggestionMatchContext {
  /** The plain text of the block or table cell with the caret. */
  readonly text: string;
  /** The caret's offset in `text`. */
  readonly caret: number;
  /** The formatted content, to check marks and links. */
  readonly content: Inline;
  /** The suggestion's triggers. */
  readonly triggers: readonly string[];
}

/** Finds the token at the caret, or returns null. See `matchToken` for building one from a scanner. */
export type SuggestionMatcher = (ctx: SuggestionMatchContext) => SuggestionMatch | null;

export interface SuggestionAllowContext {
  readonly editor: Editor;
  /** The block with the caret. For a table cell, the table. */
  readonly block: Block;
  readonly cell?: Cell;
  /** The start of the trigger, as an offset into the block's or cell's text. */
  readonly from: number;
  readonly query: string;
  /** The text before the trigger in the same block or cell. */
  readonly textBefore: string;
  /** True when the trigger is in inline code, a link, an image, raw HTML or an extension token. */
  readonly excluded: boolean;
  /** True when the user asked for the popup (Ctrl+Space), rather than typing. */
  readonly explicit: boolean;
  /** The editor's mode. In source mode `block` is the one block holding the Markdown text, and `excluded` covers its syntax, code and URLs too. */
  readonly mode: EditorMode;
}

export interface SuggestionItemsContext {
  /** What the matcher returned; for the built-in matchers, the text between the trigger and the caret, unchanged. */
  readonly query: string;
  readonly editor: Editor;
  /** True when the user asked for the popup (Ctrl+Space), rather than typing. */
  readonly explicit: boolean;
  /**
   * True while an input method is composing the query. The text may be a
   * reading that matches nothing yet; an empty result then keeps the list shown.
   */
  readonly composing: boolean;
  /** Aborted when the query changes or the popup closes. Pass it to `fetch`. */
  readonly signal: AbortSignal;
}

export interface SuggestionCommandContext<T> {
  readonly editor: Editor;
  /** The whole token: from the trigger to the end the matcher reported. */
  readonly range: SuggestionRange;
  readonly item: T;
  readonly query: string;
}

export interface SuggestionConfig<T extends SuggestionItem = SuggestionItem> {
  /** Unique among the editor's extensions. Also the name of the suggestion in `editor.suggestion.open(name)`. */
  readonly name: string;
  /**
   * Strings that start a token, such as "#", "@" or "[[". The first one is
   * what the default command writes, so `['#', '＃']` turns a full-width `＃`
   * into `#` on pick.
   */
  readonly trigger: string | readonly string[];
  /**
   * Items for the query, shown in the order given. May be async: while a
   * newer result is pending, the items shown stay usable; a result that
   * arrives after the query changed is dropped; a rejection counts as no
   * items.
   */
  readonly items: (ctx: SuggestionItemsContext) => readonly T[] | Promise<readonly T[]>;
  /**
   * Applies the picked item, usually by replacing `range`. Default: writes
   * the first trigger, the item's `value` and a space, which is left out
   * when the next character is whitespace or closing punctuation.
   */
  readonly command?: (ctx: SuggestionCommandContext<T>) => void;
  /**
   * Finds the token at the caret. Default: a trigger at the start of a line
   * or after whitespace, followed by text up to the caret with no whitespace
   * (see `allowSpaces` and `allowAnywhere`). The token must start with one of
   * the triggers.
   */
  readonly match?: SuggestionMatcher;
  /**
   * Whether the popup may open for a match. Default: not when the trigger is
   * in inline code, a link, an image, raw HTML or a token. Code blocks and
   * raw blocks never open a popup.
   */
  readonly allow?: (ctx: SuggestionAllowContext) => boolean;
  /** Default matcher only: the query may contain single spaces, and the token ends at the caret. Default false. */
  readonly allowSpaces?: boolean;
  /** Default matcher only: the trigger may follow any character. Default false: only the start of a line or whitespace. */
  readonly allowAnywhere?: boolean;
  /** Never opens in source mode: for a suggestion whose items create blocks, such as the slash menu. */
  readonly richOnly?: boolean;
  /** Waits until the query has not changed for this many ms before calling `items`. Default 0. */
  readonly debounce?: number;
  /** Most items shown. Default 50. */
  readonly limit?: number;
  /** Longest query that keeps the popup open. Default 30. */
  readonly maxLength?: number;
  /**
   * Shown when there are no items, for queries up to three characters.
   * Without it the popup hides while there are no items.
   */
  readonly emptyLabel?: string;
  /** Accessible name of the listbox. Default `labels.suggestions`. */
  readonly label?: string;
  /**
   * `false` draws no popup: matching, keys, async items and ARIA on the root
   * still work, and the app draws its own popup from `editor.suggestion.state`
   * and the `suggestionChange` event.
   */
  readonly render?: false;
  /** Extra class names for the popup element. */
  readonly className?: string;
}

/** An autocomplete popup. Add one per trigger syntax, such as tags, mentions or links. */
export function suggestion<T extends SuggestionItem>(config: SuggestionConfig<T>): Extension {
  return { name: config.name, suggestion: config as unknown as SuggestionConfig };
}
