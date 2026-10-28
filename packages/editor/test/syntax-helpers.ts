// Helpers for syntax.test.ts: a compact text form of a document, so each
// case in the spec reads as one line.

import { type Block, type Doc, type Inline, type Span, isQuotable } from '../src/model';

const TAGS: Record<string, string> = { bold: 'b', italic: 'i', strike: 's', code: 'code', html: 'html' };

function span(s: Span): string {
  let out = s.image
    ? `<img ${JSON.stringify(s.image.src)} alt=${JSON.stringify(s.image.alt)}${s.image.title ? ` title=${JSON.stringify(s.image.title)}` : ''}>`
    : s.text.replace(/\n/g, '⏎');
  if (s.token) out = `<${s.token}>${out}</${s.token}>`;
  for (let i = s.marks.length - 1; i >= 0; i--) out = `<${TAGS[s.marks[i]!]}>${out}</${TAGS[s.marks[i]!]}>`;
  return s.link === undefined ? out : `<a ${JSON.stringify(s.link)}>${out}</a>`;
}

/** Inline content as text with tags: `<b>`, `<i>`, `<s>`, `<code>`, `<html>`, `<a "url">`, `<token>`, `<img>`. "\n" is "⏎". */
export function inlineForm(inline: Inline): string {
  return inline.map(span).join('');
}

/**
 * One block as one line. A block in a quote starts with the quote and a
 * slash: "quote/h2 Title", "callout(note)/bullet:0 item". "new": the block
 * starts a new blockquote after one of the same kind.
 */
export function blockForm(b: Block): string {
  const quoted = isQuotable(b) && b.quote ? `${b.quoteStart ? 'new ' : ''}${b.callout ? `callout(${b.callout})` : 'quote'}/` : '';
  return quoted + ownForm(b);
}

function ownForm(b: Block): string {
  switch (b.type) {
    case 'paragraph':
      return `p ${inlineForm(b.content)}`;
    case 'heading':
      return `h${b.level} ${inlineForm(b.content)}`;
    case 'listItem': {
      const head = b.listType === 'task' ? `task${b.checked ? '[x]' : '[ ]'}` : b.listType;
      const start = b.start !== undefined ? `@${b.start}` : '';
      return `${head}${start}:${b.indent} ${inlineForm(b.content)}`;
    }
    case 'quote':
      return `${b.quoteStart ? 'new ' : ''}${b.callout ? `callout(${b.callout})` : 'quote'} ${inlineForm(b.content)}`;
    case 'code':
      return `code(${b.language}) ${inlineForm(b.content)}`;
    case 'raw':
      return `raw(${b.syntax}) ${inlineForm(b.content)}`;
    case 'table':
      return `table(${b.align.map((a) => a ?? '-').join(',')}) ${b.rows.map((r) => `[${r.map(inlineForm).join(' | ')}]`).join(' ')}`;
    case 'divider':
      return 'hr';
    case 'details':
      return `details${b.open ? '(open)' : ''} ${inlineForm(b.content)}`;
    case 'detailsEnd':
      return '/details';
  }
}

export function docForm(doc: Doc): string[] {
  return doc.blocks.map(blockForm);
}
