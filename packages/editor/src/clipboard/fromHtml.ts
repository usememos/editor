// Pasted HTML (web pages, Google Docs, other editors) → document model.
//
// The converter walks the DOM once. Block elements (p, h1–h6, lists, quotes,
// pre, tables, hr) become blocks; everything inline is collected into spans
// with marks and links. Formatting comes from tags (strong, em, s, code, a)
// and from inline styles (font-weight, font-style, text-decoration,
// monospace fonts), which is how Google Docs marks text: it wraps the whole
// clipboard in `<b style="font-weight:normal" id="docs-internal-guid-…">`,
// so the style must be able to cancel the tag. Whitespace is collapsed the
// way a browser renders it (honouring `white-space: pre*` and <pre>).
// Unknown elements contribute their content; script, style and other
// non-content elements are skipped.

import {
  ATOM_CHAR,
  type Align,
  type Block,
  CALLOUT_TYPES,
  type CalloutType,
  type Doc,
  type HeadingLevel,
  type ImageAtom,
  type ListType,
  type Mark,
  MAX_INDENT,
  type Span,
  codeBlock,
  details,
  detailsEnd,
  divider,
  heading,
  listItem,
  normalizeInline,
  paragraph,
  plain,
  quote,
  sortMarks,
  table,
  withQuote,
} from '../model';

export function htmlToDoc(html: string, parser?: DOMParser): Doc {
  const domParser = parser ?? (typeof DOMParser === 'undefined' ? null : new DOMParser());
  if (!domParser) throw new Error('htmlToDoc needs a DOMParser (pass one in outside the browser)');
  const dom = domParser.parseFromString(html, 'text/html');
  const converter = new Converter();
  converter.blocks(dom.body, ROOT_FORMAT);
  return { blocks: converter.finish() };
}

// ---------------------------------------------------------------------------
// Element classes

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const SKIPPED = new Set([
  'script', 'style', 'head', 'title', 'meta', 'link', 'template', 'noscript', 'iframe', 'object',
  'embed', 'svg', 'canvas', 'audio', 'video', 'select', 'textarea', 'button', 'input', 'colgroup',
]);

const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'ul', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
]);

const BLOCK_SELECTOR = [...BLOCKS].join(',');

function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

function isList(tag: string): boolean {
  return tag === 'ul' || tag === 'ol' || tag === 'menu' || tag === 'dir';
}

/** Parses an inline `style` attribute into lower-case property → value. */
function styleOf(el: Element): Map<string, string> {
  const map = new Map<string, string>();
  const style = el.getAttribute('style');
  if (!style) return map;
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    // Later declarations win, as in CSS.
    map.set(decl.slice(0, colon).trim().toLowerCase(), decl.slice(colon + 1).trim().toLowerCase());
  }
  return map;
}

// ---------------------------------------------------------------------------
// Inline format

type WhiteSpace = 'normal' | 'pre' | 'pre-line';

interface Format {
  readonly marks: readonly Mark[];
  readonly link?: string;
  readonly whiteSpace: WhiteSpace;
}

const ROOT_FORMAT: Format = { marks: [], whiteSpace: 'normal' };

const MONOSPACE = /monospace|courier|consolas|menlo|monaco|source code|roboto mono|fira code/;

/** The format inside an element: its tag and inline style applied to the parent's format. */
function formatOf(el: Element, parent: Format): Format {
  const tag = tagOf(el);
  const marks = new Set(parent.marks);
  let link = parent.link;
  let whiteSpace = parent.whiteSpace;

  if (tag === 'b' || tag === 'strong') marks.add('bold');
  if (tag === 'i' || tag === 'em' || tag === 'cite' || tag === 'dfn' || tag === 'var') marks.add('italic');
  if (tag === 's' || tag === 'del' || tag === 'strike') marks.add('strike');
  if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') marks.add('code');
  if (tag === 'pre') whiteSpace = 'pre';
  if (tag === 'a') {
    const href = el.getAttribute('href')?.trim();
    if (href && !/^(?:javascript|vbscript|data):/i.test(href)) link = href;
  }

  const style = styleOf(el);
  const weight = style.get('font-weight');
  if (weight !== undefined) {
    if (/^(?:bold|bolder|[6-9]00)$/.test(weight)) marks.add('bold');
    else if (/^(?:normal|lighter|[1-5]00)$/.test(weight)) marks.delete('bold');
  }
  const fontStyle = style.get('font-style');
  if (fontStyle !== undefined) {
    if (/^(?:italic|oblique)/.test(fontStyle)) marks.add('italic');
    else if (fontStyle === 'normal') marks.delete('italic');
  }
  // Text decorations cannot be removed by descendants, so they only add.
  if (/line-through/.test(style.get('text-decoration') ?? style.get('text-decoration-line') ?? '')) {
    marks.add('strike');
  }
  if (MONOSPACE.test(style.get('font-family') ?? '')) marks.add('code');
  const ws = style.get('white-space');
  if (ws !== undefined) {
    whiteSpace = /^(?:pre|pre-wrap|break-spaces)$/.test(ws) ? 'pre' : ws === 'pre-line' ? 'pre-line' : 'normal';
  }

  const sorted = sortMarks(marks);
  return link === undefined ? { marks: sorted, whiteSpace } : { marks: sorted, link, whiteSpace };
}

/** The callout type of a GitHub alert element (class `markdown-alert-note` and the like). */
function calloutOf(el: Element): CalloutType | undefined {
  const m = /(?:^|\s)markdown-alert-([a-z]+)(?:\s|$)/.exec(el.getAttribute('class') ?? '');
  const type = m?.[1] as CalloutType | undefined;
  return type && CALLOUT_TYPES.includes(type) ? type : undefined;
}

function hasClass(el: Element, name: string): boolean {
  return (el.getAttribute('class') ?? '').split(/\s+/).includes(name);
}

// ---------------------------------------------------------------------------
// Converter

class Converter {
  private out: Block[] = [];
  private spans: Span[] = [];

  finish(): Block[] {
    this.flush();
    return this.out;
  }

  /** Converts the children of a block-level element, except those `skip` names. */
  blocks(parent: Element, format: Format, skip?: (node: Element) => boolean): void {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === TEXT_NODE) {
        this.text(node.nodeValue ?? '', format);
      } else if (node.nodeType === ELEMENT_NODE && !skip?.(node as Element)) {
        this.element(node as Element, format);
      }
    }
  }

  private element(el: Element, parentFormat: Format): void {
    const tag = tagOf(el);
    if (SKIPPED.has(tag)) return;
    const format = formatOf(el, parentFormat);

    if (/^h[1-6]$/.test(tag)) {
      this.flush();
      const content = this.inlineOf(el, format);
      this.out.push(heading(Number(tag[1]) as HeadingLevel, content));
    } else if (isList(tag)) {
      this.flush();
      this.list(el, 0, format);
    } else if (tag === 'li') {
      // A list item outside a list.
      this.flush();
      this.listItem(el, 'bullet', 0, undefined, format);
    } else if (tag === 'details') {
      // A collapsible section: its summary is the title, everything else the body.
      this.flush();
      const summary = Array.from(el.children).find((c) => tagOf(c) === 'summary');
      const title = (summary?.textContent ?? '').replace(/\s+/g, ' ').trim();
      this.out.push(details(plain(title), { open: el.hasAttribute('open') }));
      this.blocks(el, format, (child) => child === summary);
      this.flush();
      this.out.push(detailsEnd());
    } else if (tag === 'blockquote' || calloutOf(el)) {
      this.flush();
      this.blockquote(el, format);
    } else if (tag === 'pre') {
      this.flush();
      this.out.push(codeBlock(languageOf(el), preText(el)));
    } else if (tag === 'table') {
      this.flush();
      this.table(el, format);
    } else if (tag === 'hr') {
      this.flush();
      this.out.push(divider());
    } else if (BLOCKS.has(tag)) {
      this.flush();
      this.blocks(el, format);
      this.flush();
    } else if (el.querySelector(BLOCK_SELECTOR)) {
      // An inline element wrapping blocks (like Google Docs' outer <b>):
      // its formatting applies to the blocks inside.
      this.blocks(el, format);
    } else {
      this.inline(el, parentFormat);
    }
  }

  // -- Inline content -------------------------------------------------------

  private push(text: string, format: Format, extra?: Partial<Span>): void {
    const span: Span = format.link === undefined ? { text, marks: format.marks } : { text, marks: format.marks, link: format.link };
    this.spans.push(extra ? { ...span, ...extra } : span);
  }

  /** True at the start of a block or right after a line break. */
  private atLineStart(): boolean {
    const last = this.lastChar();
    return last === '' || last === '\n';
  }

  /** The last character collected so far ("" at the start of a block). */
  private lastChar(): string {
    for (let i = this.spans.length - 1; i >= 0; i--) {
      const t = this.spans[i]!.text;
      if (t) return t[t.length - 1]!;
    }
    return '';
  }

  private text(raw: string, format: Format): void {
    let text = raw.replace(/\r\n?/g, '\n');
    if (format.whiteSpace === 'normal') text = text.replace(/[ \t\n\f]+/g, ' ');
    else if (format.whiteSpace === 'pre-line') text = text.replace(/[ \t\f]+/g, ' ').replace(/ ?\n ?/g, '\n');
    if (format.whiteSpace !== 'pre') {
      // Collapse with the space before (or a line start).
      const last = this.lastChar();
      if (text.startsWith(' ') && (last === '' || last === ' ' || last === '\n')) text = text.slice(1);
    }
    // Non-breaking spaces are plain spaces in the model.
    text = text.replace(/\u00a0/g, ' ');
    if (text) this.push(text, format);
  }

  private lineBreak(format: Format): void {
    this.trimTrailingSpace();
    this.push('\n', format);
  }

  private trimTrailingSpace(): void {
    const last = this.spans[this.spans.length - 1];
    if (last && !last.image && last.text.endsWith(' ') && !last.marks.includes('code')) {
      this.spans[this.spans.length - 1] = { ...last, text: last.text.replace(/ +$/, '') };
    }
  }

  /** Collects an inline element's content. Nested blocks become line breaks. */
  private inline(el: Element, parentFormat: Format): void {
    const tag = tagOf(el);
    if (SKIPPED.has(tag)) return;
    const format = formatOf(el, parentFormat);
    if (tag === 'br') {
      this.lineBreak(format);
      return;
    }
    if (tag === 'img') {
      const src = el.getAttribute('src') ?? '';
      if (!src || /^(?:javascript|vbscript):/i.test(src)) return;
      const alt = el.getAttribute('alt') ?? '';
      const title = el.getAttribute('title');
      // A width in whole pixels, as `<img width="320">` writes it; a percentage or CSS width is not kept.
      const size = (name: string) => {
        const value = el.getAttribute(name)?.trim() ?? '';
        return /^[1-9][0-9]{0,4}$/.test(value) ? Number(value) : 0;
      };
      const width = size('width');
      const height = width ? size('height') : 0;
      const image: ImageAtom = {
        src,
        alt,
        ...(title ? { title } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      };
      this.push(ATOM_CHAR, format, { image });
      return;
    }
    const block = BLOCKS.has(tag);
    if (block && !this.atLineStart()) this.lineBreak(format);
    this.inlineChildren(el, format);
    if (block && !this.atLineStart()) this.lineBreak(format);
  }

  private inlineChildren(el: Element, format: Format): void {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === TEXT_NODE) this.text(node.nodeValue ?? '', format);
      else if (node.nodeType === ELEMENT_NODE) this.inline(node as Element, format);
    }
  }

  /** An element's content as inline content (for headings, list items and table cells). */
  private inlineOf(el: Element, format: Format): Span[] {
    const saved = this.spans;
    this.spans = [];
    this.inlineChildren(el, format);
    const content = finishInline(this.spans);
    this.spans = saved;
    return content;
  }

  /** Ends the current run of inline content as a paragraph. */
  private flush(): void {
    const content = finishInline(this.spans);
    this.spans = [];
    if (content.length > 0) this.out.push(paragraph(content));
  }

  // -- Lists ----------------------------------------------------------------

  private list(el: Element, depth: number, format: Format): void {
    const ordered = tagOf(el) === 'ol';
    const startAttr = el.getAttribute('start');
    let start: number | undefined = ordered && startAttr && /^\d+$/.test(startAttr) ? Number(startAttr) : undefined;
    for (const child of Array.from(el.children)) {
      const tag = tagOf(child);
      if (tag === 'li') {
        this.listItem(child, ordered ? 'ordered' : 'bullet', depth, start, format);
        start = undefined;
      } else if (isList(tag)) {
        // Google Docs nests lists directly inside lists.
        this.list(child, depth + 1, formatOf(child, format));
      } else if (!SKIPPED.has(tag)) {
        this.element(child, format);
        this.flush();
      }
    }
  }

  private listItem(li: Element, type: ListType, depth: number, start: number | undefined, parentFormat: Format): void {
    const format = formatOf(li, parentFormat);
    // Google Docs gives the nesting level explicitly.
    const ariaLevel = Number(li.getAttribute('aria-level'));
    const indent = Math.min(MAX_INDENT, ariaLevel >= 1 ? ariaLevel - 1 : depth);

    let listType = type;
    let checked = false;
    const box = Array.from(li.querySelectorAll('input')).find(
      (b) => b.getAttribute('type')?.toLowerCase() === 'checkbox' && b.closest('li') === li,
    );
    if (box) {
      listType = 'task';
      checked = box.hasAttribute('checked');
    } else if (li.getAttribute('role') === 'checkbox') {
      listType = 'task';
      checked = li.getAttribute('aria-checked') === 'true';
    }

    const saved = this.spans;
    this.spans = [];
    let emitted = false;
    const emit = () => {
      if (emitted) return;
      emitted = true;
      const content = finishInline(this.spans);
      this.spans = [];
      this.out.push(listItem(listType, content, { indent, checked, start }));
    };
    for (const node of Array.from(li.childNodes)) {
      if (node.nodeType === TEXT_NODE) {
        this.text(node.nodeValue ?? '', format);
        continue;
      }
      if (node.nodeType !== ELEMENT_NODE) continue;
      const child = node as Element;
      const tag = tagOf(child);
      if (isList(tag)) {
        emit();
        this.list(child, indent + 1, formatOf(child, format));
      } else if (tag === 'p' || tag === 'div' || !BLOCKS.has(tag) || /^h[1-6]$/.test(tag)) {
        // Paragraphs of one item are joined with line breaks.
        if (!emitted && BLOCKS.has(tag) && !this.atLineStart()) this.lineBreak(format);
        this.inline(child, format);
      } else {
        emit();
        this.element(child, format);
      }
    }
    if (emitted) this.flush();
    else emit();
    this.spans = saved;
  }

  // -- Quotes and tables ----------------------------------------------------

  /** A blockquote, or a callout as GitHub renders an alert (its title is dropped). */
  private blockquote(el: Element, format: Format): void {
    const callout = calloutOf(el);
    const inner = new Converter();
    inner.blocks(el, format, callout ? (child) => hasClass(child, 'markdown-alert-title') : undefined);
    const blocks = inner.finish();
    for (const block of blocks) {
      switch (block.type) {
        case 'paragraph':
        case 'heading':
        case 'quote':
        case 'code':
        case 'raw':
          this.out.push(quote(block.content, undefined, callout));
          break;
        case 'listItem':
          this.out.push(withQuote(block, callout ?? 'quote'));
          break;
        default:
          this.out.push(block);
      }
    }
  }

  private table(el: Element, format: Format): void {
    const rows = Array.from(el.querySelectorAll('tr')).filter((tr) => tr.closest('table') === el);
    const cells = rows.map((tr) => Array.from(tr.children).filter((c) => tagOf(c) === 'td' || tagOf(c) === 'th'));
    const width = Math.max(0, ...cells.map((r) => r.length));
    if (width === 0) return;
    const align: Align[] = Array.from({ length: width }, (_, c) => alignOf(cells[0]?.[c]));
    const content = cells.map((row) => Array.from({ length: width }, (_, c) => {
      const cell = row[c];
      return cell ? this.inlineOf(cell, formatOf(cell, format)) : [];
    }));
    this.out.push(table(align, content));
  }
}

/**
 * Drops leading and trailing whitespace (and line breaks) of a block's
 * inline content and normalizes the spans.
 */
function finishInline(spans: Span[]): Span[] {
  const out = normalizeInline(spans);
  while (out.length > 0) {
    const first = out[0]!;
    if (first.image || first.marks.includes('code')) break;
    const text = first.text.replace(/^[ \n]+/, '');
    if (text) {
      out[0] = { ...first, text };
      break;
    }
    out.shift();
  }
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if (last.image || last.marks.includes('code')) break;
    const text = last.text.replace(/[ \n]+$/, '');
    if (text) {
      out[out.length - 1] = { ...last, text };
      break;
    }
    out.pop();
  }
  return out;
}

function languageOf(pre: Element): string {
  const classes = [pre.getAttribute('class') ?? '', pre.querySelector('code')?.getAttribute('class') ?? ''].join(' ');
  const m = /(?:^|\s)(?:language|lang)-([^\s]+)/.exec(classes);
  return m?.[1] ?? pre.getAttribute('data-language') ?? '';
}

/** The text of a <pre>, with <br> as line breaks, without the final line break. */
function preText(pre: Element): string {
  let text = '';
  const walk = (node: Node) => {
    if (node.nodeType === TEXT_NODE) text += node.nodeValue ?? '';
    else if (node.nodeType === ELEMENT_NODE) {
      const el = node as Element;
      if (tagOf(el) === 'br') text += '\n';
      else if (!SKIPPED.has(tagOf(el))) el.childNodes.forEach(walk);
    }
  };
  pre.childNodes.forEach(walk);
  return text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
}

function alignOf(cell: Element | undefined): Align {
  if (!cell) return null;
  // Google Docs puts the alignment on the paragraph inside the cell.
  const candidates = [cell, ...Array.from(cell.children).slice(0, 1)];
  for (const el of candidates) {
    const value = (styleOf(el).get('text-align') ?? el.getAttribute('align') ?? '').toLowerCase();
    if (value === 'left' || value === 'start') return 'left';
    if (value === 'center') return 'center';
    if (value === 'right' || value === 'end') return 'right';
  }
  return null;
}
