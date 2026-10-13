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
import type { Extension } from '../extension';
import type { InlineSyntax } from '../markdown/options';

/** Finds tags or mentions in `text[from, to)`. `text` is the whole container, so a scanner can look before `from`. */
export type TagScanner = (text: string, from: number, to: number) => Iterable<TextRange>;

export interface TagsOptions {
  /** Class on each match. Default `mbe-tag` for tags and `mbe-mention` for mentions. */
  readonly class?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  /** Finds matches in a run of text. Default `scanTags` or `scanMentions`. */
  readonly scan?: TagScanner;
}

/** A letter, combining mark, number or `_`: characters a tag or mention cannot follow. */
const reWordChar = /[\p{L}\p{M}\p{N}_]/u;
/** Characters of a tag segment: letters, marks, numbers, `_`, `-` and emoji (with joiners, variation selectors and skin tones). */
const reTagChar = /[\p{L}\p{M}\p{N}_\-\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/u;
/** First character of a segment: a letter, number, `_` or emoji. */
const reTagStart = /[\p{L}\p{N}_\p{Extended_Pictographic}]/u;
/** A tag needs one character that is not a digit, `_`, `-` or `/`. */
const reTagNeeds = /[^\p{Nd}_\-/]/u;

function charAt(text: string, i: number): string {
  return String.fromCodePoint(text.codePointAt(i)!);
}

/** The character that ends just before `i`. */
function charBefore(text: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const c = text.charCodeAt(i - 1);
  return c >= 0xdc00 && c <= 0xdfff && i > 1 ? text.slice(i - 2, i) : text[i - 1];
}

/** End of one tag segment starting at `i`, or `i` if there is none. */
function segmentEnd(text: string, i: number, to: number): number {
  if (i >= to || !reTagStart.test(charAt(text, i))) return i;
  let j = i;
  while (j < to) {
    const ch = charAt(text, j);
    if (!reTagChar.test(ch) || j + ch.length > to) break;
    j += ch.length;
  }
  return j;
}

/**
 * The default tag grammar. A tag is `#` and one or more segments separated
 * by `/`. A segment starts with a letter, number, `_` or emoji and goes on
 * with letters, combining marks, numbers, `_`, `-` and emoji. The `#` is not
 * preceded by a letter, mark, number, `_` or `#` (`C#`, `a#b` and `##x` are
 * not tags). A trailing `/` is not part of a tag, and a tag of only digits
 * (`#123`) is not a tag.
 */
export function* scanTags(text: string, from = 0, to = text.length): Generator<TextRange> {
  for (let i = text.indexOf('#', from); i >= 0 && i < to; i = text.indexOf('#', i + 1)) {
    const prev = charBefore(text, i);
    if (prev !== undefined && (prev === '#' || reWordChar.test(prev))) continue;
    let end = segmentEnd(text, i + 1, to);
    if (end === i + 1) continue;
    while (text[end] === '/') {
      const next = segmentEnd(text, end + 1, to);
      if (next === end + 1) break;
      end = next;
    }
    if (!reTagNeeds.test(text.slice(i + 1, end))) continue;
    yield { from: i, to: end };
    i = end - 1;
  }
}

/** Characters of a mention after its first one. */
const reMentionChar = /[\p{L}\p{M}\p{N}_.\-]/u;
const reMentionStart = /[\p{L}\p{N}_]/u;

/**
 * The default mention grammar: `@` and a name of letters, combining marks,
 * numbers, `_`, `.` and `-` that starts with a letter, number or `_` and does
 * not end with `.` or `-`. The `@` is not preceded by a letter, mark, number,
 * `_`, `.`, `+`, `-` or `@`, so the middle of an e-mail address is no mention.
 */
export function* scanMentions(text: string, from = 0, to = text.length): Generator<TextRange> {
  for (let i = text.indexOf('@', from); i >= 0 && i < to; i = text.indexOf('@', i + 1)) {
    const prev = charBefore(text, i);
    if (prev !== undefined && (reWordChar.test(prev) || /[.+\-@]/.test(prev))) continue;
    let end = i + 1;
    if (end >= to || !reMentionStart.test(charAt(text, end))) continue;
    while (end < to) {
      const ch = charAt(text, end);
      if (!reMentionChar.test(ch) || end + ch.length > to) break;
      end += ch.length;
    }
    while (end > i + 1 && (text[end - 1] === '.' || text[end - 1] === '-')) end--;
    yield { from: i, to: end };
    i = end - 1;
  }
}

/** Runs the scanner over each run of text with one format, skipping excluded spans. */
function decorate(scan: TagScanner, cls: string, attributes: Readonly<Record<string, string>> | undefined) {
  return ({ text, content }: DecorationContext): Decoration[] => {
    const out: Decoration[] = [];
    let pos = 0;
    for (const span of content) {
      const end = pos + span.text.length;
      if (!isExcluded(span)) {
        for (const r of scan(text, pos, end)) {
          const from = Math.max(r.from, pos);
          const to = Math.min(r.to, end);
          if (to > from) out.push(attributes ? { from, to, class: cls, attributes } : { from, to, class: cls });
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

function build(name: string, char: string, scan: TagScanner, defaultClass: string, options: TagsOptions): Extension {
  return {
    name,
    markdown: { inline: [escapeSyntax(char)] },
    decorations: decorate(options.scan ?? scan, options.class ?? defaultClass, options.attributes),
  };
}

/** `#tag` highlighting and `\#` escapes. */
export function tags(options: TagsOptions = {}): Extension {
  return build('tags', '#', scanTags, 'mbe-tag', options);
}

/** `@name` highlighting and `\@` escapes. */
export function mentions(options: TagsOptions = {}): Extension {
  return build('mentions', '@', scanMentions, 'mbe-mention', options);
}
