// GFM autolink literals (the "Autolinks (extension)" section of the GFM
// spec): `www.`, `http://`, `https://` and `ftp://` URLs and e-mail
// addresses written without angle brackets. Shared by the inline parser,
// the serializer and the typing rule that links a URL when a space is
// typed after it.

/** Characters of a domain segment. Non-ASCII letters and digits are allowed, as in cmark-gfm. */
const reDomain = /(?:[\p{L}\p{N}_-]+)(?:\.[\p{L}\p{N}_-]+)*/uy;
const reWww = /www\./iy;
const reScheme = /(?:https?|ftp):\/\//iy;
const reEmail = /[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/g;
/** Trailing characters that are not part of a URL. */
const TRAILING = '?!.,:*_~';

/**
 * Whether a URL literal may start after `prev`: at the
 * start of a line, after whitespace, or after `*`, `_`, `~` or `(`.
 */
export function isLiteralBoundary(prev: string | undefined): boolean {
  return prev === undefined || /[\s*_~(]/.test(prev);
}

/** A valid domain: segments separated by periods, at least one period, no "_" in the last two segments. */
function domainEnd(text: string, pos: number, requirePeriod: boolean): number {
  reDomain.lastIndex = pos;
  const m = reDomain.exec(text);
  if (!m) return -1;
  // A trailing "_" is punctuation after the domain, as in micromark:
  // `_www.example.com_` is emphasis around a link.
  const domain = m[0].replace(/_+$/, '');
  const segments = domain.split('.');
  if (segments.some((s) => s === '')) return -1;
  if (requirePeriod && segments.length < 2) return -1;
  if (segments.slice(-2).some((s) => s.includes('_'))) return -1;
  return pos + domain.length;
}

/** Trims trailing punctuation, unbalanced closing parentheses and entity-like endings. */
function trimEnd(text: string, start: number, end: number): number {
  for (;;) {
    const ch = text[end - 1]!;
    if (TRAILING.includes(ch)) {
      end--;
    } else if (ch === ')') {
      let open = 0;
      let close = 0;
      for (let i = start; i < end; i++) {
        if (text[i] === '(') open++;
        else if (text[i] === ')') close++;
      }
      if (close <= open) return end;
      end--;
    } else if (ch === ';') {
      // "&hl;" looks like an entity reference: leave it out. A lone ";" too.
      let i = end - 2;
      while (i >= start && /[A-Za-z0-9]/.test(text[i]!)) i--;
      end = i >= start && text[i] === '&' && i < end - 2 ? i : end - 1;
    } else {
      return end;
    }
    if (end <= start) return end;
  }
}

/**
 * A `www.`, `http(s)://` or `ftp://` literal starting at `pos`: its end
 * (exclusive) and link destination, or null. The caller checks the boundary
 * before `pos`.
 */
export function urlLiteralAt(text: string, pos: number): { end: number; href: string } | null {
  let afterPrefix: number;
  let www = false;
  reWww.lastIndex = pos;
  if (reWww.test(text)) {
    afterPrefix = pos;
    www = true;
  } else {
    reScheme.lastIndex = pos;
    if (!reScheme.test(text)) return null;
    afterPrefix = reScheme.lastIndex;
  }
  const domain = domainEnd(text, afterPrefix, true);
  if (domain < 0) return null;
  let end = domain;
  while (end < text.length && !/[\s<]/.test(text[end]!)) end++;
  end = trimEnd(text, pos, end);
  if (end < domain || end <= afterPrefix) return null;
  const literal = text.slice(pos, end);
  return { end, href: www ? 'http://' + literal : literal };
}

/** E-mail literals in plain text: `[from, to)` ranges. */
export function emailLiterals(text: string): { from: number; to: number }[] {
  if (!text.includes('@')) return [];
  const out: { from: number; to: number }[] = [];
  reEmail.lastIndex = 0;
  for (const m of text.matchAll(reEmail)) {
    const last = m[0][m[0].length - 1]!;
    if (last === '-' || last === '_') continue;
    out.push({ from: m.index!, to: m.index! + m[0].length });
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
