// @usememos/editor/emoji: `:name` autocomplete that writes the emoji itself,
// as GitHub, Notion and Linear offer. The names are GitHub's (gemoji). The
// list of 1,870 emoji loads the first time the popup opens, so an app pays
// for it only when someone types an emoji.

import { type Extension, type SuggestionItem, containerContent, inlineText, suggestion } from '@usememos/editor';
import { type Emoji, parseEmoji, searchEmoji } from './search';

export { type Emoji, parseEmoji, searchEmoji } from './search';

export interface EmojiOptions {
  /** The suggestion's name, for `editor.suggestion.open(name)`. Default `emoji`. */
  readonly name?: string;
  /** Most emoji shown. Default 8. */
  readonly limit?: number;
  /** Characters typed after `:` before the popup opens, so `:)` and `a :b` stay quiet. Default 2. Ctrl+Space opens it sooner. */
  readonly minLength?: number;
  /** Accessible name of the popup. Default `Emoji`. */
  readonly label?: string;
}

interface EmojiItem extends SuggestionItem {
  readonly value: string;
}

let loading: Promise<readonly Emoji[]> | null = null;

/** Every emoji the extension offers, loaded once on first use. */
export function loadEmoji(): Promise<readonly Emoji[]> {
  loading ??= import('./data').then((m) => parseEmoji(m.EMOJI_DATA));
  return loading;
}

/** A character of an emoji name. */
const NAME_CHAR = /[a-z0-9_+-]/i;

/** Characters before which a pick adds no space, as for the editor's other suggestions. */
const NO_SPACE_BEFORE = /[\s.,;:!?)\]}>'"’”»）」』】、。，．：；！？]/;

/**
 * Emoji autocomplete: typing `:` and two letters at the start of a word lists
 * emoji by GitHub's names and tags (`:tada`, `:party`). A pick replaces the
 * typed name with the emoji, so the Markdown holds the character itself.
 */
export function emoji(options: EmojiOptions = {}): Extension {
  const { name = 'emoji', limit = 8, minLength = 2 } = options;
  return suggestion<EmojiItem>({
    name,
    trigger: [':', '：'],
    label: options.label ?? 'Emoji',
    className: 'mbe-emoji-menu',
    allow: ({ excluded, explicit, query }) => !excluded && (explicit || query.length >= minLength) && [...query].every((c) => NAME_CHAR.test(c)),
    items: async ({ query }) =>
      searchEmoji(await loadEmoji(), query, limit).map((e) => ({ id: e.names[0], label: `:${e.names[0]}:`, icon: e.emoji, value: e.emoji })),
    command: ({ editor, range, item, query }) => {
      // Replace the trigger and the name, also the part after the caret, but not what follows the name, such as "!".
      const block = editor.state.doc.blocks.find((b) => b.id === range.from.blockId);
      const content = block && containerContent(block, range.from.cell);
      const text = content ? inlineText(content) : '';
      let end = range.from.offset + 1 + query.length;
      while (end < range.to.offset && NAME_CHAR.test(text[end]!)) end++;
      const to = { ...range.from, offset: end };
      const next = text[end];
      // In source mode a line ending is the end of the block: the space is added, as at a block's end.
      const atLineEnd = next === '\n' && editor.mode === 'source';
      const space = next !== undefined && !atLineEnd && NO_SPACE_BEFORE.test(next) ? '' : ' ';
      editor.commands.insertText(item.value + space, { range: { from: range.from, to } });
    },
  });
}
