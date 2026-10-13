// Finding the token at the caret. Pure functions of text: no DOM.

import { isExcluded } from '../decorations';
import type { SuggestionMatcher } from '../extensions/suggestion';
import type { TagScanner } from '../extensions/tags';
import type { Inline } from '../model';

export interface DefaultMatcherOptions {
  readonly allowSpaces?: boolean;
  readonly allowAnywhere?: boolean;
  readonly maxLength?: number;
}

/**
 * The matcher of a suggestion without `match`: the nearest trigger before
 * the caret, at the start of a line or after whitespace (any character with
 * `allowAnywhere`), followed by a query with no whitespace (single spaces
 * with `allowSpaces`). The token ends at the next whitespace after the
 * caret, or at the caret with `allowSpaces`.
 */
export function defaultMatcher({ allowSpaces = false, allowAnywhere = false, maxLength = 30 }: DefaultMatcherOptions = {}): SuggestionMatcher {
  const invalid = allowSpaces ? /\s\s|\n/ : /\s/;
  return ({ text, caret, triggers }) => {
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    const longest = Math.max(0, ...triggers.map((t) => t.length));
    const lowest = Math.max(lineStart, caret - maxLength - longest);
    for (let i = caret - 1; i >= lowest; i--) {
      const trigger = longestAt(text, i, triggers, caret);
      if (!trigger) continue;
      const query = text.slice(i + trigger.length, caret);
      // A longer query only adds characters, so once one is invalid, every trigger further back is too.
      if (query.length > maxLength || invalid.test(query)) return null;
      const before = text[i - 1];
      if (!allowAnywhere && before !== undefined && !/\s/.test(before)) continue;
      let to = caret;
      if (!allowSpaces) while (to < text.length && !/\s/.test(text[to]!)) to++;
      return { from: i, to, query };
    }
    return null;
  };
}

const reJoining = /^[\p{M}\u200c\u200d\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u;

export interface MatchTokenOptions {
  /** A character the scanner accepts inside a token, inserted at the caret while scanning. Default "a". */
  readonly probe?: string;
  /** Longest query. Default 30. */
  readonly maxLength?: number;
}

/**
 * Builds a matcher from a scanner, the same kind of function `tags({ scan })`
 * takes, so the popup opens exactly where the text is highlighted. A probe
 * character is inserted at the caret before scanning, so the scanner sees a
 * token the user is still typing (`#` alone, or `#work/`) as a whole one.
 * The scanner sees other triggers of the same length written as the first
 * one, so a scanner for `#` also finds tokens typed with `＃`.
 */
export function matchToken(scan: TagScanner, { probe = 'a', maxLength = 30 }: MatchTokenOptions = {}): SuggestionMatcher {
  return ({ text, caret, triggers }) => {
    // A caret inside a character cluster (before a combining mark, a variation
    // selector or a joiner, as in the keycap emoji #️⃣) is not in a token.
    const next = text.codePointAt(caret);
    if (next !== undefined && reJoining.test(String.fromCodePoint(next))) return null;
    let scanned = text;
    const first = triggers[0];
    if (first) for (const t of triggers) if (t !== first && t.length === first.length) scanned = scanned.split(t).join(first);
    const probed = scanned.slice(0, caret) + probe + scanned.slice(caret);
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    let lineEnd = text.indexOf('\n', caret);
    if (lineEnd < 0) lineEnd = text.length;
    const reach = maxLength + 16;
    const from = Math.max(lineStart, caret - reach);
    const to = Math.min(lineEnd + probe.length, caret + probe.length + reach);
    for (const token of scan(probed, from, to)) {
      if (token.from >= caret || token.to < caret + probe.length) continue;
      const trigger = longestAt(text, token.from, triggers, caret);
      if (!trigger) return null;
      const query = text.slice(token.from + trigger.length, caret);
      if (query.length > maxLength) return null;
      return { from: token.from, to: token.to - probe.length, query };
    }
    return null;
  };
}

/** The longest trigger at `i` that ends at or before `limit`. */
export function longestAt(text: string, i: number, triggers: readonly string[], limit = text.length): string | null {
  let found: string | null = null;
  for (const t of triggers) {
    if (t && i + t.length <= limit && text.startsWith(t, i) && (!found || t.length > found.length)) found = t;
  }
  return found;
}

/** True when the character at `offset` is in inline code, a link, an image, raw HTML or a token. */
export function excludedAt(content: Inline, offset: number): boolean {
  let pos = 0;
  for (const span of content) {
    const end = pos + span.text.length;
    if (offset < end) return isExcluded(span);
    pos = end;
  }
  return false;
}
