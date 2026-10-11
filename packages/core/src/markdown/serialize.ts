// Markdown serializer. Output is normalized, not a copy of the original
// source: `*` for italic, `**` for bold, `~~` for strikethrough, ATX headings,
// one blank line between blocks, and empty paragraphs dropped.

import { type Block, type Doc, type Inline, type Mark, MARK_ORDER, normalizeInline, sortMarks } from '../model';

export function serializeMarkdown(doc: Doc): string {
  const parts = doc.blocks.map(serializeBlock).filter((s) => s !== '');
  return parts.length ? parts.join('\n\n') + '\n' : '';
}

function serializeBlock(block: Block): string {
  switch (block.type) {
    case 'paragraph':
      return escapeLineStart(serializeInline(block.content));
    case 'heading': {
      let text = serializeInline(block.content);
      // A trailing "#" run would be read as the closing sequence.
      text = text.replace(/(^|\s)(#+)$/, (_m, sp: string, hashes: string) => `${sp}\\${hashes}`);
      return `${'#'.repeat(block.level)}${text ? ' ' + text : ''}`;
    }
  }
}

/** Escapes characters at the start of a paragraph that would start another block. */
function escapeLineStart(text: string): string {
  if (/^(#{1,6})(\s|$)/.test(text) || /^[>=]/.test(text) || /^[-+](\s|$)/.test(text) || /^-{3,}\s*$/.test(text)) {
    return '\\' + text;
  }
  return text.replace(/^(\d{1,9})([.)])(\s|$)/, '$1\\$2$3');
}

const DELIMS: Record<Exclude<Mark, 'code'>, string> = { bold: '**', italic: '*', strike: '~~' };

export function serializeInline(inline: Inline): string {
  const spans = moveWhitespaceOutOfMarks(inline);
  let out = '';
  const open: { mark: Mark; delim: string }[] = [];

  spans.forEach((span, index) => {
    const target: Mark[] = span.marks.filter((m) => m !== 'code');
    // Close marks that end here. Closing an outer mark closes everything inside it.
    let keep = 0;
    while (keep < open.length && target.includes(open[keep]!.mark)) keep++;
    const closedAt = out.length;
    for (let k = open.length - 1; k >= keep; k--) out += open[k]!.delim;
    const justClosedStar = out.length > closedAt && out.endsWith('*');
    open.length = keep;

    // Open new marks, the one that stays open longest first, so it is outermost.
    const toOpen = target.filter((m) => !open.some((o) => o.mark === m));
    toOpen.sort((a, b) => runEnd(spans, index, b) - runEnd(spans, index, a) || MARK_ORDER.indexOf(a) - MARK_ORDER.indexOf(b));
    for (const m of toOpen) {
      // "*" right after a closing "*" would merge into one delimiter run.
      const delim = m === 'italic' && justClosedStar ? '_' : DELIMS[m as keyof typeof DELIMS];
      out += delim;
      open.push({ mark: m, delim });
    }

    const prevChar = out[out.length - 1];
    const nextSpan = spans[index + 1];
    out += span.marks.includes('code') ? codeSpan(span.text) : escapeText(span.text, prevChar, nextSpan?.text[0]);
  });
  for (let k = open.length - 1; k >= 0; k--) out += open[k]!.delim;
  return out;
}

function runEnd(spans: Inline, from: number, mark: Mark): number {
  let i = from;
  while (i < spans.length && spans[i]!.marks.includes(mark)) i++;
  return i;
}

/**
 * "**foo **bar" does not parse as bold, because a closing delimiter cannot
 * follow whitespace. Leading and trailing whitespace of a marked run is moved
 * outside the mark.
 */
function moveWhitespaceOutOfMarks(inline: Inline): Inline {
  const chars: { ch: string; marks: Set<Mark> }[] = [];
  for (const span of inline) for (const ch of span.text) chars.push({ ch, marks: new Set(span.marks) });
  for (const mark of ['bold', 'italic', 'strike'] as const) {
    let i = 0;
    while (i < chars.length) {
      if (!chars[i]!.marks.has(mark)) {
        i++;
        continue;
      }
      let j = i;
      while (j < chars.length && chars[j]!.marks.has(mark)) j++;
      for (let k = i; k < j && /\s/.test(chars[k]!.ch); k++) chars[k]!.marks.delete(mark);
      for (let k = j - 1; k >= i && /\s/.test(chars[k]!.ch); k--) chars[k]!.marks.delete(mark);
      i = j;
    }
  }
  return normalizeInline(chars.map((c) => ({ text: c.ch, marks: sortMarks(c.marks) })));
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '');
  return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

const ALNUM = /[\p{L}\p{N}]/u;

function escapeText(text: string, prevChar: string | undefined, nextChar: string | undefined): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const before = i > 0 ? text[i - 1] : prevChar;
    const after = i < text.length - 1 ? text[i + 1] : nextChar;
    if ('\\`*~[]<'.includes(ch)) {
      out += '\\' + ch;
    } else if (ch === '_') {
      // Intraword underscores (snake_case) cannot open or close emphasis.
      const intraword = before !== undefined && after !== undefined && ALNUM.test(before) && ALNUM.test(after);
      out += intraword ? ch : '\\_';
    } else if (ch === '&' && /^&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/.test(text.slice(i))) {
      out += '\\&';
    } else {
      out += ch;
    }
  }
  return out;
}
