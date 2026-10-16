// Document model → semantic HTML, for the `text/html` clipboard flavour.
//
// Consecutive list items become properly nested <ul>/<ol> elements, task
// items get a disabled checkbox, adjacent quote blocks and quoted list items
// share one <blockquote> (a callout's with GitHub's alert classes), and code blocks carry their language as a `language-x` class
// (the convention most sites and editors read back). Raw HTML (html blocks
// and `html`-marked text) is written verbatim, as a Markdown renderer would;
// all other text is escaped.

import {
  type Block,
  type CalloutType,
  type Doc,
  type Inline,
  type ListItemBlock,
  type Span,
  imageBlockOffset,
  inlineText,
  quoteKind,
  sameQuote,
  sliceInline,
  unquote,
  sameLink,
} from '../model';

export function docToHtml(doc: Doc): string {
  let out = '';
  const blocks = doc.blocks;
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    const kind = quoteKind(block);
    if (kind) {
      // One blockquote holds the quote's paragraphs and lists.
      let j = i + 1;
      while (j < blocks.length && sameQuote(block, blocks[j])) j++;
      out += quoteHtml(kind === 'quote' ? undefined : kind, docToHtml({ blocks: blocks.slice(i, j).map(unquote) }));
      i = j;
    } else if (block.type === 'listItem') {
      let j = i;
      while (j < blocks.length && blocks[j]!.type === 'listItem' && quoteKind(blocks[j]) === null) j++;
      out += listHtml(blocks.slice(i, j) as ListItemBlock[]);
      i = j;
    } else {
      out += blockHtml(block);
      i++;
    }
  }
  return out;
}

function blockHtml(block: Block): string {
  switch (block.type) {
    case 'paragraph': {
      // An image block keeps its alignment, as other apps read it.
      const at = imageBlockOffset(block);
      const align = at === null ? undefined : sliceInline(block.content, at, at + 1)[0]?.image?.align;
      return `<p${align ? ` style="text-align:${align}"` : ''}>${inlineHtml(block.content)}</p>`;
    }
    case 'heading':
      return `<h${block.level}>${inlineHtml(block.content)}</h${block.level}>`;
    case 'code': {
      const cls = block.language ? ` class="language-${escapeHtml(block.language)}"` : '';
      return `<pre><code${cls}>${escapeHtml(inlineText(block.content))}</code></pre>`;
    }
    case 'raw':
      return block.syntax === 'html' ? inlineText(block.content) : `<pre>${escapeHtml(inlineText(block.content))}</pre>`;
    case 'divider':
      return '<hr>';
    // The body's blocks come between, so the two parts make one element.
    case 'details':
      return `<details${block.open ? ' open' : ''}><summary>${escapeHtml(inlineText(block.content))}</summary>`;
    case 'detailsEnd':
      return '</details>';
    case 'table': {
      const cell = (tag: string, content: Inline, c: number) => {
        const align = block.align[c];
        return `<${tag}${align ? ` style="text-align: ${align}"` : ''}>${inlineHtml(content)}</${tag}>`;
      };
      const [head, ...body] = block.rows;
      let html = '<table>';
      if (head) html += `<thead><tr>${head.map((c, i) => cell('th', c, i)).join('')}</tr></thead>`;
      if (body.length > 0) html += `<tbody>${body.map((row) => `<tr>${row.map((c, i) => cell('td', c, i)).join('')}</tr>`).join('')}</tbody>`;
      return html + '</table>';
    }
    case 'listItem':
    case 'quote':
      return docToHtml({ blocks: [block] });
  }
}

/**
 * A blockquote. A callout gets GitHub's alert classes, which htmlToDoc reads
 * back, and a bold title that shows in apps that drop the classes.
 */
function quoteHtml(callout: CalloutType | undefined, inner: string): string {
  if (!callout) return `<blockquote>${inner}</blockquote>`;
  const title = callout[0]!.toUpperCase() + callout.slice(1);
  return `<blockquote class="markdown-alert markdown-alert-${callout}"><p class="markdown-alert-title"><strong>${title}</strong></p>${inner}</blockquote>`;
}

/**
 * Nests a run of list items by indent. A new list starts at a level when the
 * kind changes (ordered versus bullet and task items).
 */
function listHtml(items: readonly ListItemBlock[]): string {
  let out = '';
  // Open lists, innermost last. Each has its tag and whether an <li> is open.
  const open: { tag: 'ul' | 'ol'; liOpen: boolean }[] = [];
  const closeTo = (depth: number) => {
    while (open.length > depth) {
      const list = open.pop()!;
      if (list.liOpen) out += '</li>';
      out += `</${list.tag}>`;
    }
  };

  for (const item of items) {
    const tag = item.listType === 'ordered' ? 'ol' : 'ul';
    // Nest at most one level below the current depth.
    const level = Math.min(item.indent, open.length);
    closeTo(level + 1);
    const current = open[level];
    if (current && current.tag !== tag) closeTo(level);
    if (!open[level]) {
      const start = item.listType === 'ordered' && item.start !== undefined ? ` start="${item.start}"` : '';
      out += `<${tag}${start}>`;
      open.push({ tag, liOpen: false });
    }
    const list = open[level]!;
    if (list.liOpen) out += '</li>';
    const checkbox =
      item.listType === 'task' ? `<input type="checkbox" disabled${item.checked ? ' checked' : ''}> ` : '';
    out += `<li>${checkbox}${inlineHtml(item.content)}`;
    list.liOpen = true;
  }
  closeTo(0);
  return out;
}

/** Escapes text for HTML content and attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

/** Inline content: runs with the same link share one <a>; marks nest inside it. */
function inlineHtml(inline: Inline): string {
  let out = '';
  let i = 0;
  while (i < inline.length) {
    const { link, linkTitle } = inline[i]!;
    let j = i;
    let inner = '';
    while (j < inline.length && sameLink(inline[j]!, inline[i]!)) inner += spanHtml(inline[j++]!);
    const title = linkTitle ? ` title="${escapeHtml(linkTitle)}"` : '';
    out += link === undefined ? inner : `<a href="${escapeHtml(link)}"${title}>${inner}</a>`;
    i = j;
  }
  return out;
}

function spanHtml(span: Span): string {
  let html: string;
  if (span.image) {
    const { src, alt, title, width, height } = span.image;
    html = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ''}`;
    if (width) html += ` width="${width}"${height ? ` height="${height}"` : ''}`;
    html += '>';
  } else if (span.marks.includes('html')) {
    html = span.text;
  } else {
    html = escapeHtml(span.text).replace(/\n/g, '<br>');
  }
  if (span.marks.includes('code')) html = `<code>${html}</code>`;
  if (span.marks.includes('strike')) html = `<s>${html}</s>`;
  if (span.marks.includes('italic')) html = `<em>${html}</em>`;
  if (span.marks.includes('bold')) html = `<strong>${html}</strong>`;
  return html;
}
