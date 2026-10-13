// suggestion: a popup menu opened by a trigger character, like Tiptap's
// Suggestion utility. The editor's slash menu is built on it, and so is
// #tag autocomplete in an app.

import type { Editor } from '../editor';
import type { Extension } from '../extension';
import type { Icon } from '../icons';
import type { Position } from '../model';

export interface SuggestionItem {
  /** Stable ID, for tests and keys. Defaults to the label. */
  readonly id?: string;
  readonly label: string;
  /** Shown before the label: text, or an element (such as an `<svg>`) that is cloned. */
  readonly icon?: Icon;
}

export interface SuggestionRange {
  /** The trigger character. */
  readonly from: Position;
  /** The caret: the end of the query. */
  readonly to: Position;
}

export interface SuggestionConfig<T extends SuggestionItem = SuggestionItem> {
  /** Characters that open the menu, such as "#" or "/". */
  readonly char: string | readonly string[];
  /**
   * Items for the text typed after the trigger. May be async; a result that
   * arrives after the query changed is dropped.
   */
  readonly items: (ctx: { readonly query: string; readonly editor: Editor }) => readonly T[] | Promise<readonly T[]>;
  /** Applies the picked item. `range` covers the trigger and the query, for replacing them. */
  readonly command: (ctx: { readonly editor: Editor; readonly range: SuggestionRange; readonly item: T; readonly query: string }) => void;
  /** Whether the query may contain single spaces. Default false: a space closes the menu. */
  readonly allowSpaces?: boolean;
  /** Whether the trigger opens the menu inside a word. Default false: only at the start of a line or after whitespace. */
  readonly allowAnywhere?: boolean;
  /** Longest query that keeps the menu open. Default 30. */
  readonly maxLength?: number;
  /**
   * Shown when there are no items, for queries up to three characters.
   * Without it the menu hides while there are no items.
   */
  readonly emptyLabel?: string;
  /** Extra class names for the menu element. */
  readonly className?: string;
}

export function suggestion<T extends SuggestionItem>(config: SuggestionConfig<T> & { readonly name?: string }): Extension {
  return { name: config.name ?? 'suggestion', suggestion: config as unknown as SuggestionConfig };
}
