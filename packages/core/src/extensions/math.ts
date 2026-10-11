// Math: `$…$` and `$$…$$` inline, and `$$` fenced blocks. Kept as source
// and saved verbatim, so a renderer such as remark-math or KaTeX shows it.
// The rules follow memos' math syntax: an inline opener followed by a space,
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

const inline: InlineSyntax = {
  name: 'math',
  triggers: '$',
  match(text, pos) {
    // The tail of a dollar run that did not open math is plain text.
    if (text.charCodeAt(pos - 1) === DOLLAR) return -1;
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

export function math(): Extension {
  return { name: 'math', markdown: { inline: [inline], block: [block], escape: '$' } };
}
