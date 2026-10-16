// Math: `$…$` and `$$…$$` inline, and `$$` fenced blocks. Saved verbatim.
// With a `render` function (for example KaTeX's), formulas show rendered,
// and their source shows while the caret is on them; without one they show
// as source.
// The rules follow Pandoc's tex_math_dollars: an inline opener followed by a space,
// or a closer preceded by a space or followed by a digit, is a plain dollar
// sign ("costs $5 and $10" is text).

import type { Extension } from '../extension';
import type { BlockSyntax, InlineSyntax } from '../markdown/options';

const DOLLAR = 0x24;

function isWhitespace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/** True if the character at `i` follows an odd number of backslashes. */
function escaped(text: string, i: number): boolean {
  let n = 0;
  while (text.charCodeAt(i - n - 1) === 0x5c) n++;
  return n % 2 === 1;
}

const inline: InlineSyntax = {
  name: 'math',
  triggers: '$',
  match(text, pos) {
    // The tail of a dollar run that did not open math is plain text. An escaped `\$` is not part of a run.
    if (text.charCodeAt(pos - 1) === DOLLAR && !escaped(text, pos - 1)) return -1;
    let openEnd = pos;
    while (text.charCodeAt(openEnd) === DOLLAR) openEnd++;
    const size = openEnd - pos;
    if (size === 1 && isWhitespace(text[openEnd])) return -1;
    for (let i = openEnd; i < text.length; ) {
      if (text.charCodeAt(i) !== DOLLAR) {
        i++;
        continue;
      }
      let closeEnd = i + 1;
      while (text.charCodeAt(closeEnd) === DOLLAR) closeEnd++;
      if (closeEnd - i === size) {
        if (size === 1 && (isWhitespace(text[i - 1]) || isDigit(text[closeEnd]))) return -1;
        return closeEnd;
      }
      i = closeEnd;
    }
    return -1;
  },
};

/** Size of an opening `$$` fence, if the line is one: two or more dollars and no dollar after them. */
function fenceSize(line: string): number {
  let end = 0;
  while (line.charCodeAt(end) === DOLLAR) end++;
  return end >= 2 && !line.includes('$', end) ? end : 0;
}

const block: BlockSyntax = {
  name: 'math',
  interruptsParagraph: true,
  open(line) {
    const size = fenceSize(line);
    if (!size) return null;
    return {
      next(l) {
        const trimmed = l.replace(/^[ \t]+/, '');
        let end = 0;
        while (trimmed.charCodeAt(end) === DOLLAR) end++;
        return end >= size && /^[ \t]*$/.test(trimmed.slice(end)) ? 'close' : 'continue';
      },
    };
  },
};

export interface MathOptions {
  /**
   * Renders TeX into `element`. `displayMode` is true for a `$$` block.
   * KaTeX's `render` has this shape:
   * `render: (tex, el, options) => katex.render(tex, el, { ...options, throwOnError: false })`.
   * Throwing shows the source instead. A renderer that loads on demand can
   * return a promise; the source shows until it resolves (see `views`).
   */
  readonly render?: (tex: string, element: HTMLElement, options: { readonly displayMode: boolean }) => void | PromiseLike<void>;
}

/** The TeX inside a token (`$x$`, `$$x$$`) or a fenced block (`$$` lines around it). */
export function mathSource(source: string, kind: 'inline' | 'block'): string {
  if (kind === 'inline') {
    let size = 0;
    while (source.charCodeAt(size) === DOLLAR) size++;
    return source.slice(size, source.length - size);
  }
  const lines = source.split('\n');
  const closed = lines.length > 1 && /^[ \t]*\${2,}[ \t]*$/.test(lines[lines.length - 1]!);
  return lines.slice(1, closed ? -1 : undefined).join('\n');
}

export function math(options: MathOptions = {}): Extension {
  const { render } = options;
  return {
    name: 'math',
    markdown: { inline: [inline], block: [block], escape: '$' },
    views: render && {
      math(source, element, kind) {
        const tex = mathSource(source, kind);
        if (!tex.trim()) return false;
        const result = render(tex, element, { displayMode: kind === 'block' });
        if (!result) return;
        // While the renderer loads, the formula's source shows in its place.
        if (!element.hasChildNodes()) element.textContent = source;
        return result;
      },
    },
  };
}
