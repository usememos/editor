// A copy of memos' tag scanner (usememos/memos web/src/utils/tag-grammar.ts),
// with its generated Unicode tables replaced by regular expression
// properties. Tests use it to check that `matchToken` works with a grammar
// other than the editor's: memos' tags have no left-boundary rule (`hello#x`
// is a tag), allow `-`, `+`, `&` and apostrophes, and tell keycap emoji
// (`#️⃣`) from a tag introducer.

import type { TextRange } from '../../src/decorations';

const reEmoji = new RegExp('\\p{RGI_Emoji}', 'vy');
const reXid = /\p{XID_Continue}/u;
const reIgnorable = /\p{Default_Ignorable_Code_Point}/u;
const reMark = /\p{M}/u;

const codePointAt = (s: string, i: number) => {
  const v = s.codePointAt(i);
  return v === undefined ? '' : String.fromCodePoint(v);
};
const isIgnorable = (c: string) => reIgnorable.test(c);
const isXid = (c: string) => reXid.test(c) && !isIgnorable(c);
const isMark = (c: string) => reMark.test(c);
const isExtension = (c: string) => c === '-' || c === '+' || c === '&';
const isApostrophe = (c: string) => c === "'" || c === '’';

function emojiAt(s: string, i: number, limit: number): string | undefined {
  reEmoji.lastIndex = i;
  const m = reEmoji.exec(s.slice(0, limit));
  return m ? m[0] : undefined;
}

function segmentEnd(s: string, from: number, limit: number): number | undefined {
  let i = from;
  while (i < limit) {
    const c = codePointAt(s, i);
    if (isIgnorable(c) || (isXid(c) && isMark(c))) i += c.length;
    else break;
  }
  let prevXid = false;
  const starter = emojiAt(s, i, limit);
  if (starter) i += starter.length;
  else {
    const c = codePointAt(s, i);
    if (!c || (!(isXid(c) && !isMark(c)) && !isExtension(c))) return undefined;
    i += c.length;
    prevXid = isXid(c);
  }
  while (i < limit) {
    const emoji = emojiAt(s, i, limit);
    if (emoji) {
      i += emoji.length;
      prevXid = false;
      continue;
    }
    const c = codePointAt(s, i);
    if (isIgnorable(c)) {
      i += c.length;
      prevXid = false;
      continue;
    }
    const next = codePointAt(s, i + c.length);
    if (isApostrophe(c) && prevXid && i + c.length < limit && !emojiAt(s, i + c.length, limit) && isXid(next) && !isMark(next)) {
      i += c.length;
      prevXid = false;
      continue;
    }
    if (isXid(c) || isExtension(c)) {
      i += c.length;
      prevXid = isXid(c);
      continue;
    }
    break;
  }
  return i;
}

function tagAt(s: string, from: number, limit: number): TextRange | undefined {
  if (s[from] !== '#' || emojiAt(s, from, limit)) return undefined;
  let to = segmentEnd(s, from + 1, limit);
  if (to === undefined) return undefined;
  while (to < limit && s[to] === '/') {
    const next = segmentEnd(s, to + 1, limit);
    if (next === undefined) break;
    to = next;
  }
  return { from, to };
}

/** memos' `findTagMatches`, as a `TagScanner`. */
export function* scanMemosTags(s: string, from = 0, limit = s.length): Generator<TextRange> {
  let i = from;
  while (i < limit) {
    const emoji = emojiAt(s, i, limit);
    if (emoji) {
      i += emoji.length;
      continue;
    }
    if (s[i] === '#') {
      const tag = tagAt(s, i, limit);
      if (tag) {
        yield tag;
        i = tag.to;
        continue;
      }
    }
    i += codePointAt(s, i).length || 1;
  }
}
