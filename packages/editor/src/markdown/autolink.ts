// GFM autolink literals (the "Autolinks (extension)" section of the GFM
// spec): `www.`, `http://`, `https://` and `ftp://` URLs and e-mail
// addresses written without angle brackets. Shared by the inline parser,
// the serializer and the typing rule that links a URL when a space is
// typed after it.

const reScheme = /(?:https?|ftp):\/\//iy;
const reAsciiAlnum = /[A-Za-z0-9]/;
/** Trailing characters that are not part of a URL. */
const TRAILING = '?!.,:*_~\'"';

/**
 * Whether a URL literal may start after `prev`, as in cmark-gfm. A `www.`
 * literal starts at the start of the text, after a space, tab or line break, or after `*`,
 * `_`, `~` or `(`. A scheme starts after anything but an ASCII letter, which
 * would be part of the scheme: `0http://a.b` holds a link, `xhttp://a.b` none.
 */
export function isLiteralBoundary(prev: string | undefined, www: boolean): boolean {
  if (prev === undefined) return true;
  return www ? /[ \t\n\r*_~(]/.test(prev) : !/[A-Za-z]/.test(prev);
}

/**
 * The end of a valid domain starting at `pos`, or -1, as cmark-gfm's
 * `check_domain`: it reads ASCII letters, digits, "-", "_" and "." (and
 * escaped characters) and stops at anything else; the text after it is still
 * part of the URL. A `www.` domain needs a period. A "_" in either of the
 * last two segments read rejects it, unless there are more than ten periods.
 * As in cmark-gfm, the first character is not read, nor is the last one of
 * the text, so `www.` at the very end is not a domain.
 */
function domainEnd(text: string, pos: number, requirePeriod: boolean): number {
  let periods = 0;
  let underscoresBefore = 0;
  let underscores = 0;
  let i = pos + 1;
  for (; i < text.length - 1; i++) {
    if (text[i] === '\\' && i < text.length - 2) i++;
    const c = text[i]!;
    if (c === '_') underscores++;
    else if (c === '.') {
      underscoresBefore = underscores;
      underscores = 0;
      periods++;
    } else if (!reAsciiAlnum.test(c) && c !== '-') break;
  }
  if ((underscoresBefore > 0 || underscores > 0) && periods <= 10) return -1;
  if (requirePeriod && periods === 0) return -1;
  return i;
}

/**
 * Trims trailing punctuation, unbalanced closing parentheses and
 * entity-like endings (`&hl;`), as cmark-gfm's `autolink_delim`.
 */
function trimEnd(text: string, start: number, end: number): number {
  let open = 0;
  let close = 0;
  for (let i = start; i < end; i++) {
    if (text[i] === '(') open++;
    else if (text[i] === ')') close++;
  }
  while (end > start) {
    const ch = text[end - 1]!;
    if (TRAILING.includes(ch)) {
      end--;
    } else if (ch === ')') {
      if (close <= open) return end;
      close--;
      end--;
    } else if (ch === ';') {
      // "&hl;" looks like an entity reference: leave it out. A lone ";" too.
      let i = end - 2;
      while (i > start && /[A-Za-z]/.test(text[i]!)) i--;
      end = i < end - 2 && text[i] === '&' ? i : end - 1;
    } else {
      return end;
    }
  }
  return end;
}

/**
 * A `www.`, `http(s)://` or `ftp://` literal starting at `pos`: its end
 * (exclusive) and link destination, or null. `www.` and the scheme may be in
 * any case, as on github.com. The caller checks the boundary before `pos`.
 */
export function urlLiteralAt(text: string, pos: number): { end: number; href: string } | null {
  let domainStart: number;
  const www = text.slice(pos, pos + 4).toLowerCase() === 'www.';
  if (www) {
    domainStart = pos;
  } else {
    reScheme.lastIndex = pos;
    if (!reScheme.test(text)) return null;
    domainStart = reScheme.lastIndex;
    // After a scheme the domain starts with a letter or digit: `http://-a` is text.
    if (!/[\p{L}\p{N}]/u.test(text[domainStart] ?? '')) return null;
  }
  // As in cmark-gfm, only a `www.` domain needs a period: `http://localhost:3000` is a link.
  const domain = domainEnd(text, domainStart, www);
  if (domain < 0) return null;
  let end = domain;
  // Only a space, tab or line break ends it (cmark-gfm's `cmark_isspace`).
  while (end < text.length && !/[ \t\n\r<]/.test(text[end]!)) end++;
  end = trimEnd(text, pos, end);
  if (end <= domainStart) return null;
  const literal = text.slice(pos, end);
  return { end, href: www ? 'http://' + literal : literal };
}

/**
 * E-mail literals in plain text, as cmark-gfm finds them: `[from, to)`
 * ranges. Before the "@", ASCII letters, digits, ".", "+", "-" and "_";
 * after it, letters, digits, "-", "_" and periods followed by a letter or
 * digit, with at least one period. The address ends with a letter, so
 * `react@0.11.1` is not one.
 */
export function emailLiterals(text: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let done = 0;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    let from = at;
    while (from > done && /[A-Za-z0-9.+\-_]/.test(text[from - 1]!)) from--;
    if (from === at) continue;
    let to = at;
    let ats = 0;
    let periods = 0;
    for (; to < text.length; to++) {
      const c = text[to]!;
      if (reAsciiAlnum.test(c)) continue;
      if (c === '@') {
        // A second @ rejects the address, so the scan can stop (`a@a@a@…` stays linear).
        if (++ats > 1) break;
      } else if (c === '.' && reAsciiAlnum.test(text[to + 1] ?? '')) periods++;
      else if (c !== '-' && c !== '_') break;
    }
    if (to - at < 2 || ats !== 1 || periods === 0 || !/[A-Za-z]/.test(text[to - 1]!)) continue;
    out.push({ from, to });
    done = to;
    at = to - 1;
  }
  return out;
}

/** The link a literal's text stands for, if the whole text is one literal; else null. */
export function literalHref(text: string): string | null {
  const url = urlLiteralAt(text, 0);
  if (url) return url.end === text.length ? url.href : null;
  const emails = emailLiterals(text);
  return emails.length === 1 && emails[0]!.from === 0 && emails[0]!.to === text.length ? 'mailto:' + text : null;
}
