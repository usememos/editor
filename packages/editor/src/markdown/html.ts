// Renders a Markdown syntax tree to HTML, byte for byte like the CommonMark
// reference implementation (and cmark-gfm for tables and task items). Used by
// the spec tests and handy for debugging the parser.

import { escapeHtml } from '../clipboard/toHtml';
import { type BlockNode, type InlineNode, type ListItemNode, type Root, inlineNodesText } from './ast';

export function renderAstToHtml(root: Root): string {
  const r = new Renderer();
  for (const block of root.children) r.block(block, false);
  return r.out;
}

/** ASCII characters left as they are in URLs; everything else is percent-encoded. */
const URL_SAFE = /[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/;

/**
 * Percent-encodes a link destination like the reference implementation
 * (mdurl's `encode`): existing `%XX` escapes are kept, unsafe ASCII and all
 * non-ASCII characters are encoded as UTF-8.
 */
function encodeUrl(url: string): string {
  let out = '';
  for (let i = 0; i < url.length; i++) {
    const ch = url[i]!;
    const code = url.charCodeAt(i);
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(url.slice(i + 1, i + 3))) {
      out += url.slice(i, i + 3);
      i += 2;
    } else if (code < 128) {
      out += URL_SAFE.test(ch) ? ch : '%' + code.toString(16).toUpperCase().padStart(2, '0');
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < url.length) {
      const low = url.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        out += encodeURIComponent(url.slice(i, i + 2));
        i += 1;
      } else {
        out += '%EF%BF%BD';
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      out += '%EF%BF%BD'; // lone surrogate
    } else {
      out += encodeURIComponent(ch);
    }
  }
  return out;
}

class Renderer {
  out = '';
  /** A task item's checkbox, written at the start of its first paragraph. */
  private checkbox = '';

  /** Adds a line ending unless the output already ends with one. */
  private cr(): void {
    if (this.out.length > 0 && !this.out.endsWith('\n')) this.out += '\n';
  }

  block(node: BlockNode, tight: boolean): void {
    switch (node.type) {
      case 'paragraph':
        // Paragraphs in tight lists are rendered without <p> tags.
        if (tight) {
          this.inlines(node.children);
        } else {
          this.cr();
          this.out += '<p>' + this.checkbox;
          this.checkbox = '';
          this.inlines(node.children);
          this.out += '</p>';
          this.cr();
        }
        break;
      case 'heading':
        this.cr();
        this.out += `<h${node.level}>`;
        this.inlines(node.children);
        this.out += `</h${node.level}>`;
        this.cr();
        break;
      case 'thematicBreak':
        this.cr();
        this.out += '<hr />';
        this.cr();
        break;
      case 'codeBlock': {
        this.cr();
        const lang = node.info.split(/[ \t\n]+/)[0];
        this.out += lang ? `<pre><code class="language-${escapeHtml(lang)}">` : '<pre><code>';
        this.out += escapeHtml(node.value) + '</code></pre>';
        this.cr();
        break;
      }
      case 'htmlBlock':
        this.cr();
        this.out += node.value;
        this.cr();
        break;
      case 'raw':
        this.cr();
        this.out += `<pre>${escapeHtml(node.value)}</pre>`;
        this.cr();
        break;
      case 'blockQuote':
        this.cr();
        this.out += '<blockquote>';
        this.cr();
        for (const child of node.children) this.block(child, false);
        this.cr();
        this.out += '</blockquote>';
        this.cr();
        break;
      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul';
        this.cr();
        this.out += node.ordered && node.start !== 1 ? `<ol start="${node.start}">` : `<${tag}>`;
        this.cr();
        for (const item of node.items) this.item(item, node.tight);
        this.cr();
        this.out += `</${tag}>`;
        this.cr();
        break;
      }
      case 'table': {
        this.cr();
        this.out += '<table>\n<thead>\n';
        node.rows.forEach((row, r) => {
          if (r === 1) this.out += '<tbody>\n';
          const cellTag = r === 0 ? 'th' : 'td';
          this.out += '<tr>\n';
          row.forEach((cell, c) => {
            const align = node.align[c];
            this.out += align ? `<${cellTag} align="${align}">` : `<${cellTag}>`;
            this.inlines(cell);
            this.out += `</${cellTag}>\n`;
          });
          this.out += '</tr>\n';
          if (r === 0) this.out += '</thead>\n';
        });
        if (node.rows.length > 1) this.out += '</tbody>\n';
        this.out += '</table>';
        this.cr();
        break;
      }
    }
  }

  private item(item: ListItemNode, tight: boolean): void {
    this.out += '<li>';
    const box = !item.task ? '' : item.checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ';
    // In a loose item, inside the paragraph, as cmark-gfm writes it.
    if (!tight && item.children[0]?.type === 'paragraph') this.checkbox = box;
    else this.out += box;
    for (const child of item.children) this.block(child, tight);
    this.out += '</li>';
    this.cr();
  }

  private inlines(nodes: readonly InlineNode[]): void {
    for (const node of nodes) this.inline(node);
  }

  private inline(node: InlineNode): void {
    switch (node.type) {
      case 'text':
        this.out += escapeHtml(node.value);
        break;
      case 'softBreak':
        this.out += '\n';
        break;
      case 'hardBreak':
        this.out += '<br />\n';
        break;
      case 'code':
        this.out += `<code>${escapeHtml(node.value)}</code>`;
        break;
      case 'html':
        this.out += node.value;
        break;
      case 'token':
        this.out += escapeHtml(node.value);
        break;
      case 'emphasis':
        this.out += '<em>';
        this.inlines(node.children);
        this.out += '</em>';
        break;
      case 'strong':
        this.out += '<strong>';
        this.inlines(node.children);
        this.out += '</strong>';
        break;
      case 'strike':
        this.out += '<del>';
        this.inlines(node.children);
        this.out += '</del>';
        break;
      case 'link':
        this.out += `<a href="${escapeHtml(encodeUrl(node.destination))}"`;
        if (node.title) this.out += ` title="${escapeHtml(node.title)}"`;
        this.out += '>';
        this.inlines(node.children);
        this.out += '</a>';
        break;
      case 'image':
        this.out += `<img src="${escapeHtml(encodeUrl(node.destination))}" alt="${escapeHtml(inlineNodesText(node.children, '\n'))}"`;
        if (node.title) this.out += ` title="${escapeHtml(node.title)}"`;
        this.out += ' />';
        break;
    }
  }
}
