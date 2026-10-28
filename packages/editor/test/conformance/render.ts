// The editor's rendered output as plain HTML, for comparison with what other
// renderers give for the same Markdown (see conformance.test.ts). Needs a DOM
// (`// @vitest-environment happy-dom`).
//
// The editor draws its own elements: flat list items with an indent, quotes
// split into parts, code blocks with a toolbar. This file reads that DOM back
// into the HTML a Markdown renderer would give for the same rendering, so a
// difference is a difference a reader would see, not a difference in markup.
//
// Raw HTML renders through a test `html` view that keeps the source as
// tokens, which `editorHtml` writes back unescaped. The browser's HTML parser
// then builds it together with the content around it, as it does for the
// other renderers' output.

import { Editor } from '../../src/editor';
import type { Extension } from '../../src/extension';
import { SLOT_MARKER } from '../../src/markdown/htmlSection';
import type { MarkdownOptions } from '../../src/markdown/options';

const OPEN = '⟦H:';
const CLOSE = '⟧';
const reToken = /⟦H:([^⟧]*)⟧/g;

/** Shows raw HTML as tokens of its source, around the slot markers that fillSlots replaces with Markdown content. */
const rawHtml: Extension = {
  name: 'conformance-html',
  views: {
    html(source, element) {
      const marker = new RegExp(SLOT_MARKER.source, 'g');
      let text = '';
      let last = 0;
      for (const m of source.matchAll(marker)) {
        if (m.index > last) text += OPEN + encodeURIComponent(source.slice(last, m.index)) + CLOSE;
        text += m[0];
        last = m.index + m[0].length;
      }
      if (last < source.length) text += OPEN + encodeURIComponent(source.slice(last)) + CLOSE;
      element.textContent = text;
    },
  },
};

export interface RenderOptions {
  readonly markdown?: MarkdownOptions;
  readonly extensions?: readonly Extension[];
}

/** Renders `markdown` in a read-only editor and returns the HTML a reader sees. */
export function renderEditor(markdown: string, options: RenderOptions = {}): string {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    content: markdown,
    editable: false,
    markdown: options.markdown,
    extensions: [...(options.extensions ?? []), rawHtml],
    // Every URL as written: URL policy is tested separately.
    resolveUrl: (url) => url,
  });
  try {
    return editorHtml(element);
  } finally {
    editor.destroy();
    element.remove();
  }
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

/** A text node's text, with raw HTML tokens written back as HTML and line breaks as <br>. */
function text(value: string, verbatim = false): string {
  let out = '';
  let last = 0;
  for (const m of value.matchAll(reToken)) {
    out += plain(value.slice(last, m.index), verbatim) + decodeURIComponent(m[1]!);
    last = m.index + m[0].length;
  }
  return out + plain(value.slice(last), verbatim);
}

const plain = (s: string, verbatim: boolean) => (verbatim ? escapeText(s) : escapeText(s).replace(/\n/g, '<br>'));

const has = (el: Element, name: string) => el.classList.contains(name);

/** The HTML of the editor's root element: its blocks. */
export function editorHtml(root: HTMLElement): string {
  return flow(Array.from(root.children) as HTMLElement[]);
}

/** A sequence of block elements, with flat list items, quote parts and sections put back together. */
function flow(blocks: HTMLElement[]): string {
  let out = '';
  for (let i = 0; i < blocks.length; ) {
    const el = blocks[i]!;
    if (isQuotePart(el)) {
      // Adjacent quote parts that the editor joins are one quote.
      let end = i + 1;
      while (end < blocks.length && isQuotePart(blocks[end]!) && blocks[end]!.hasAttribute('data-quote-joined')) end++;
      out += quote(blocks.slice(i, end));
      i = end;
    } else if (has(el, 'mbe-list-item')) {
      let end = i + 1;
      while (end < blocks.length && has(blocks[end]!, 'mbe-list-item') && !blocks[end]!.hasAttribute('data-list-start')) end++;
      out += lists(blocks.slice(i, end));
      i = end;
    } else if (has(el, 'mbe-details')) {
      // A section runs to its end block; sections nest.
      let depth = 0;
      let end = i + 1;
      for (; end < blocks.length; end++) {
        if (has(blocks[end]!, 'mbe-details')) depth++;
        else if (has(blocks[end]!, 'mbe-details-end') && depth-- === 0) break;
      }
      const title = el.querySelector(':scope > .mbe-content')!;
      out += `<details><summary>${inline(title)}</summary>${flow(blocks.slice(i + 1, end))}</details>`;
      i = end + 1;
    } else {
      out += block(el);
      i++;
    }
  }
  return out;
}

/** A quote part: a quote paragraph, or a list item, heading, code block, raw block, divider or table inside a quote. Not a quote the model cannot hold, which renders whole. */
function isQuotePart(el: HTMLElement): boolean {
  return el.tagName === 'BLOCKQUOTE' && (has(el, 'mbe-list-item') || !el.querySelector(':scope > .mbe-flow'));
}

function quote(parts: HTMLElement[]): string {
  const callout = parts[0]!.dataset.callout;
  let inner = '';
  for (let i = 0; i < parts.length; ) {
    if (has(parts[i]!, 'mbe-list-item')) {
      let end = i + 1;
      while (end < parts.length && has(parts[end]!, 'mbe-list-item') && !parts[end]!.hasAttribute('data-list-start')) end++;
      inner += lists(parts.slice(i, end));
      i = end;
    } else {
      // A quote paragraph holds its text; any other quoted block holds the block's own element (see renderBlock).
      inner += has(parts[i]!, 'mbe-quote') ? `<p>${inline(parts[i]!)}</p>` : block(parts[i]!);
      i++;
    }
  }
  return `<blockquote${callout ? ` data-alert="${callout}"` : ''}>${inner}</blockquote>`;
}

/** Flat list items, each with an indent, as nested lists. */
function lists(items: HTMLElement[]): string {
  let out = '';
  /** The open lists, outermost first: whether each is ordered. */
  const open: boolean[] = [];
  const close = (depth: number) => {
    while (open.length > depth) out += `</li></${open.pop() ? 'ol' : 'ul'}>`;
  };
  for (const item of items) {
    const depth = Number(item.dataset.indent ?? 0) + 1;
    const ordered = item.dataset.listType === 'ordered';
    close(depth);
    if (open.length === depth && open[depth - 1] !== ordered) close(depth - 1);
    if (open.length === depth) out += '</li>';
    while (open.length < depth) {
      // An item deeper than the one before it opens a list in that item; missing levels get an empty item.
      if (open.length > 0 && out.endsWith('</li>')) out = out.slice(0, -'</li>'.length);
      const opening = open.length === depth - 1;
      const start = opening && ordered ? Number.parseInt(item.querySelector(':scope > .mbe-marker')?.textContent ?? '1', 10) : 1;
      out += opening && ordered ? (start !== 1 ? `<ol start="${start}">` : '<ol>') : '<ul>';
      open.push(opening && ordered);
      if (!opening) out += '<li>';
    }
    out += '<li>';
    const box = item.querySelector<HTMLInputElement>(':scope > .mbe-marker > input');
    if (box) out += `<input type="checkbox" disabled${box.checked ? ' checked' : ''}> `;
    const content = item.querySelector<HTMLElement>(':scope > .mbe-content')!;
    const nested = content.querySelector<HTMLElement>(':scope > .mbe-flow');
    out += nested ? flow(Array.from(nested.children) as HTMLElement[]) : inline(content);
  }
  close(0);
  return out;
}

function block(el: HTMLElement): string {
  // A block in a quote is a blockquote holding the block's own element, which carries the block's data and views (see renderBlock).
  const quoted = el.tagName === 'BLOCKQUOTE' && !has(el, 'mbe-quote') && !has(el, 'mbe-list-item') ? el.querySelector<HTMLElement>(':scope > .mbe-content') : null;
  const own = quoted ?? el;
  if (has(own, 'mbe-view-markdown')) return flow(Array.from(own.querySelector(':scope > .mbe-flow')!.children) as HTMLElement[]);
  if (own.dataset.syntax === 'html') return has(own, 'mbe-view-html') ? inline(own) : `<pre>${escapeText(own.textContent ?? '')}</pre>`;
  if (own.dataset.syntax) return `<pre data-raw="${escapeAttr(own.dataset.syntax)}">${escapeText(own.textContent ?? '')}</pre>`;
  if (el.tagName === 'BLOCKQUOTE' && el.querySelector(':scope > .mbe-flow')) {
    // A quote the model cannot hold, such as one inside a quote.
    const callout = el.dataset.callout;
    return `<blockquote${callout ? ` data-alert="${callout}"` : ''}>${flow(Array.from(el.querySelector(':scope > .mbe-flow')!.children) as HTMLElement[])}</blockquote>`;
  }
  if (own.tagName === 'P' || /^H[1-6]$/.test(own.tagName)) {
    const tag = own.tagName.toLowerCase();
    return `<${tag}>${inline(own)}</${tag}>`;
  }
  if (has(el, 'mbe-code')) {
    const language = (own.dataset.language ?? '').split(/\s/)[0];
    const code = own.querySelector('pre > code')!;
    return `<pre><code${language ? ` class="language-${escapeAttr(language)}"` : ''}>${text(code.textContent ?? '', true)}</code></pre>`;
  }
  if (has(el, 'mbe-divider')) return '<hr>';
  if (has(el, 'mbe-table')) {
    const rows = Array.from(own.querySelectorAll('tr')).map((tr) => {
      const cells = Array.from(tr.children as HTMLCollectionOf<HTMLElement>).map((cell) => {
        const tag = cell.tagName.toLowerCase();
        const align = cell.style.textAlign;
        return `<${tag}${align ? ` align="${align}"` : ''}>${inline(cell)}</${tag}>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    });
    return `<table>${rows.join('')}</table>`;
  }
  if (has(el, 'mbe-details-end')) return '';
  return `<div data-unknown-block="${escapeAttr(el.className)}">${inline(own)}</div>`;
}

const MARKS: Record<string, string> = { STRONG: 'strong', EM: 'em', S: 'del', CODE: 'code' };

/** Inline content: text, marks, links, images, and raw HTML from the view, with any Markdown its slots hold. */
function inline(parent: Element): string {
  let out = '';
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) {
      out += text((node as Text).data);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as HTMLElement;
    if (el.tagName === 'BR' && el.hasAttribute('data-mbe-fill')) continue;
    if (el.tagName === 'BR') out += '<br>';
    else if (has(el, 'mbe-flow')) out += flow(Array.from(el.children) as HTMLElement[]);
    else if (el.tagName === 'IMG') {
      const title = el.getAttribute('title');
      out += `<img src="${escapeAttr(el.getAttribute('src') ?? '')}" alt="${escapeAttr(el.getAttribute('alt') ?? '')}"${title !== null ? ` title="${escapeAttr(title)}"` : ''}>`;
    } else if (has(el, 'mbe-image-unavailable')) out += `<img alt="${escapeAttr(el.getAttribute('aria-label') ?? '')}">`;
    else if (el.tagName === 'A') {
      const href = el.getAttribute('href');
      const title = el.getAttribute('title');
      out += `<a${href !== null ? ` href="${escapeAttr(href)}"` : ''}${title !== null ? ` title="${escapeAttr(title)}"` : ''}>${inline(el)}</a>`;
    } else if (el.tagName === 'CODE') out += `<code>${escapeText(el.textContent ?? '')}</code>`;
    else if (MARKS[el.tagName]) out += `<${MARKS[el.tagName]}>${inline(el)}</${MARKS[el.tagName]}>`;
    // Raw HTML shown as source (no view, or a run that crosses a link): the reader sees its text.
    else if (has(el, 'mbe-raw-html')) out += escapeText(el.textContent ?? '');
    // Decorations, tokens and views add no meaning of their own.
    else out += inline(el);
  }
  return out;
}
