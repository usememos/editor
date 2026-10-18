// tags() and mentions(): `#tag` and `@name` written as plain text,
// highlighted with decorations. For a popup, add a `suggestion()` with
// `matchToken` and the same scanner.
//
// Tags and mentions are never parsed into the document. They are text, saved
// exactly as typed. A backslash before the trigger (`\#`, `\@`) is kept as a
// token, so an escaped character survives edits and is never highlighted.
//
// The scanner sees one run of text with a single format at a time, so a tag
// is never highlighted across formatting (`#**work**` is no tag), nor inside
// inline code, links, images, raw HTML or tokens.

import { type Decoration, type DecorationContext, type TextRange, isExcluded } from '../decorations';
import type { Editor } from '../editor';
import type { Extension } from '../extension';
import type { InlineSyntax } from '../markdown/options';
import { isMac } from '../ui/popup';

/** Finds tags or mentions in `text[from, to)`. `text` is the whole container, so a scanner can look before `from`. */
export type TagScanner = (text: string, from: number, to: number) => Iterable<TextRange>;

export interface TagsOptions {
  /**
   * Class on each match. Default `mbe-tag` for tags and `mbe-mention` for
   * mentions. A function gets the match as written (`#work/planning`), for a
   * class per tag or per person.
   */
  readonly class?: string | ((match: string) => string);
  /** Attributes on each match, or a function of the match, such as `data-tag` or a custom color. */
  readonly attributes?: Readonly<Record<string, string>> | ((match: string) => Readonly<Record<string, string>> | undefined);
  /** Finds matches in a run of text. Default `scanTags` or `scanMentions`. */
  readonly scan?: TagScanner;
  /**
   * Called when a match is clicked to be followed, as `onLinkClick` is for a
   * link: a plain click while read-only, Mod+click while editing. `match` is
   * the text as written (`#work/planning`). Return true to handle it: the
   * click then goes no further, neither to the browser nor to the page's
   * own listeners. With this option, read-only matches show a pointer
   * cursor, and mentions underline on hover; the editor marks each match with
   * `data-mbe-tag` or `data-mbe-mention`.
   */
  readonly onClick?: (ctx: { readonly editor: Editor; readonly match: string; readonly event: MouseEvent }) => boolean | void;
}

// The grammar is memos' (usememos/memos markdown/parser/tag.go and
// mention.go), applied to the text a reader sees.

const reXidContinue = /\p{XID_Continue}/u;
const reIgnorable = /\p{Default_Ignorable_Code_Point}/u;
const reCombining = /[\p{Mn}\p{Mc}]/u;
/** Not XID_Continue, but kept inside a tag as twitter-text does: 〃, ～, 〜, Hebrew ־ ׳ ״ and the Tibetan tsheg. */
const TWITTER_CONTINUE = '\u3003\uff5e\u301c\u05be\u05f3\u05f4\u0f0b';

/**
 * One fully qualified emoji at the start of the text (sticky): a keycap, a
 * flag, a subdivision flag, or emoji joined by zero-width joiners, each with
 * its skin tone or emoji presentation selector. A character that shows as
 * text by default (`♥`) is an emoji only with the selector (U+FE0F). A code
 * point reserved for emoji that the engine's Unicode data does not know yet
 * counts as one.
 */
const EMOJI_ELEMENT = String.raw`(?:\p{Emoji_Modifier_Base}\p{Emoji_Modifier}|(?![\p{Regional_Indicator}\p{Emoji_Modifier}])\p{Emoji_Presentation}\uFE0F?|(?![#*0-9])\p{Emoji}\uFE0F|(?!\p{Emoji})(?=\P{Assigned})\p{Extended_Pictographic})`;
const reEmoji = new RegExp(
  String.raw`[#*0-9]\uFE0F\u20E3|\p{Regional_Indicator}{2}|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|${EMOJI_ELEMENT}(?:\u200D${EMOJI_ELEMENT})*`,
  'uy',
);

function charAt(text: string, i: number): string {
  return String.fromCodePoint(text.codePointAt(i)!);
}

/** Length of the emoji at `i` that ends by `to`, or 0. */
function emojiAt(text: string, i: number, to: number): number {
  reEmoji.lastIndex = i;
  const m = reEmoji.exec(text);
  return m && i + m[0].length <= to ? m[0].length : 0;
}

const isXid = (ch: string) => reXidContinue.test(ch) && !reIgnorable.test(ch);
const isStarter = (ch: string) => ch === '-' || ch === '+' || ch === '&' || (isXid(ch) && !reCombining.test(ch));
const isContinuation = (ch: string) => ch === '-' || ch === '+' || ch === '&' || TWITTER_CONTINUE.includes(ch) || isXid(ch);

/**
 * End of one tag segment starting at `i`, or -1 if there is none. Default
 * ignorable characters (joiners, variation selectors) and combining marks
 * before the first character are skipped, as are ignorable characters
 * inside; they stay part of the tag as written.
 */
function segmentEnd(text: string, i: number, to: number): number {
  let j = i;
  // The first character: a letter, digit, connector, `-`, `+`, `&` or emoji.
  for (;;) {
    if (j >= to) return -1;
    const emoji = emojiAt(text, j, to);
    if (emoji > 0) {
      j += emoji;
      break;
    }
    const ch = charAt(text, j);
    if (j + ch.length > to) return -1;
    if (reIgnorable.test(ch) || (reXidContinue.test(ch) && reCombining.test(ch))) {
      j += ch.length;
      continue;
    }
    if (!isStarter(ch)) return -1;
    j += ch.length;
    break;
  }
  // Then the same, combining marks, and an apostrophe between two letters (`#tag's`).
  let afterXid = j > i && isXid(charBefore(text, j)!);
  while (j < to) {
    const emoji = emojiAt(text, j, to);
    if (emoji > 0) {
      j += emoji;
      afterXid = false;
      continue;
    }
    const ch = charAt(text, j);
    if (j + ch.length > to) break;
    if (reIgnorable.test(ch)) {
      j += ch.length;
      afterXid = false;
    } else if ((ch === "'" || ch === '\u2019') && afterXid && startsWord(text, j + 1, to)) {
      j += 1;
      afterXid = false;
    } else if (isContinuation(ch)) {
      j += ch.length;
      afterXid = isXid(ch);
    } else {
      break;
    }
  }
  return j;
}

/** True if a letter or digit that is not a combining mark or an emoji starts at `i`. */
function startsWord(text: string, i: number, to: number): boolean {
  if (i >= to || emojiAt(text, i, to) > 0) return false;
  const ch = charAt(text, i);
  return isXid(ch) && !reCombining.test(ch);
}

/** The character that ends just before `i`. */
function charBefore(text: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const c = text.charCodeAt(i - 1);
  return c >= 0xdc00 && c <= 0xdfff && i > 1 ? text.slice(i - 2, i) : text[i - 1];
}

/**
 * The default tag grammar, memos': `#` and one or more segments separated
 * by `/`. A segment is letters, digits and other Unicode identifier
 * characters (XID_Continue), `-`, `+`, `&`, emoji, and an apostrophe between
 * two letters (`#tag's`); it does not start with a combining mark. Anything
 * may come before the `#` (`3pm#work`), and a `#` inside an emoji (the keycap `#`)
 * starts no tag. `#2024` is a tag. A trailing `/` is not part of a tag.
 */
export function* scanTags(text: string, from = 0, to = text.length): Generator<TextRange> {
  let i = from;
  while (i < to) {
    const emoji = emojiAt(text, i, to);
    if (emoji > 0) {
      i += emoji;
      continue;
    }
    if (text[i] !== '#') {
      i += charAt(text, i).length;
      continue;
    }
    let end = segmentEnd(text, i + 1, to);
    if (end < 0) {
      i++;
      continue;
    }
    while (text[end] === '/') {
      const next = segmentEnd(text, end + 1, to);
      if (next < 0) break;
      end = next;
    }
    yield { from: i, to: end };
    i = end;
  }
}

/** A character of a username: an ASCII letter or digit, or `-`. */
const reUsernameChar = /[A-Za-z0-9-]/;
/** Latin letters with accents: a name that runs into one is no mention (twitter-text). */
const reLatinAccent = /[\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f\u0253\u0254\u0256\u0257\u0259\u025b\u0263\u0268\u026f\u0272\u0289\u028b\u02bb\u0300-\u036f\u1e00-\u1eff]/;

/**
 * The default mention grammar, memos' usernames: `@` and up to 36 ASCII
 * letters, digits and `-`, starting and ending with a letter or digit. The
 * character before the `@` is not a username character (`中文@dave` is a
 * mention, `foo@bar` is not); formatting that starts right at the `@`
 * counts as a boundary, as its delimiter does in the Markdown. A name that
 * runs on into a character it cannot hold, such as `-` at the end or an
 * accented letter (`@alicé`), is no mention.
 */
export function* scanMentions(text: string, from = 0, to = text.length): Generator<TextRange> {
  for (let i = text.indexOf('@', from); i >= 0 && i < to; i = text.indexOf('@', i + 1)) {
    if (i > from && reUsernameChar.test(text[i - 1]!)) continue;
    let end = i + 1;
    while (end < to && reUsernameChar.test(text[end]!)) end++;
    const name = text.slice(i + 1, end);
    const valid = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,34}[A-Za-z0-9])?$/.test(name) && !reLatinAccent.test(text[end] ?? '');
    if (valid) yield { from: i, to: end };
    if (end > i + 1) i = end - 1;
  }
}

/** Runs the scanner over each run of text with one format, skipping excluded spans. `mark` is an attribute set to each match, for clicks. */
function decorate(scan: TagScanner, cls: NonNullable<TagsOptions['class']>, attributes: TagsOptions['attributes'], mark?: string) {
  return ({ text, content }: DecorationContext): Decoration[] => {
    const out: Decoration[] = [];
    let pos = 0;
    for (const span of content) {
      const end = pos + span.text.length;
      if (!isExcluded(span)) {
        for (const r of scan(text, pos, end)) {
          const from = Math.max(r.from, pos);
          const to = Math.min(r.to, end);
          if (to <= from) continue;
          const match = text.slice(from, to);
          const className = typeof cls === 'function' ? cls(match) : cls;
          const given = typeof attributes === 'function' ? attributes(match) : attributes;
          const attrs = mark ? { ...given, [mark]: match } : given;
          out.push(attrs ? { from, to, class: className, attributes: attrs } : { from, to, class: className });
        }
      }
      pos = end;
    }
    return out;
  };
}

/** `\#` or `\@` kept as written, so the escape survives edits. */
function escapeSyntax(ch: string): InlineSyntax {
  return { name: 'escape', triggers: '\\', match: (text, pos) => (text[pos + 1] === ch ? pos + 2 : -1) };
}

function build(name: string, char: string, scan: TagScanner, defaultClass: string, mark: string, options: TagsOptions): Extension {
  const onClick = options.onClick;
  const extension: Extension = {
    name,
    markdown: { inline: [escapeSyntax(char)] },
    decorations: decorate(options.scan ?? scan, options.class ?? defaultClass, options.attributes, onClick ? mark : undefined),
  };
  if (!onClick) return extension;
  return {
    ...extension,
    // A click on a match follows it as a click on a link does (see Editor.onClick): read-only, or Mod+click while editing.
    onCreate: ({ editor }) => {
      const handle = (e: MouseEvent) => {
        const el = (e.target as HTMLElement).closest?.<HTMLElement>(`[${mark}]`);
        if (!el || !editor.root.contains(el) || (editor.isEditable && !(isMac ? e.metaKey : e.ctrlKey))) return;
        if (onClick({ editor, match: el.getAttribute(mark)!, event: e })) {
          e.preventDefault();
          e.stopPropagation();
        }
      };
      editor.root.addEventListener('click', handle);
      return () => editor.root.removeEventListener('click', handle);
    },
  };
}

/** `#tag` highlighting and `\#` escapes. */
export function tags(options: TagsOptions = {}): Extension {
  return build('tags', '#', scanTags, 'mbe-tag', 'data-mbe-tag', options);
}

/** `@name` highlighting and `\@` escapes. */
export function mentions(options: TagsOptions = {}): Extension {
  return build('mentions', '@', scanMentions, 'mbe-mention', 'data-mbe-mention', options);
}
