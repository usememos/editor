// Puts HTML in one canonical form, so that two renderings compare equal when
// a reader would see the same thing. Needs a DOM (happy-dom).
//
// Differences that are dropped, because a reader cannot see them:
// - whitespace between blocks, runs of whitespace, and whitespace at the
//   start and end of a block or next to a line break (outside <pre>);
// - how marks nest: `<em><strong>a</strong></em>` equals
//   `<strong><em>a</em></strong>`, and `<em>a</em><em>b</em>` equals `<em>ab</em>`;
// - tight and loose list items: text directly in a list item counts as a
//   paragraph (the spacing differs, the structure does not);
// - <thead> and <tbody>, attribute order, `open` on <details>, `<s>` and
//   `<del>`, and how a URL is percent-encoded;
// - runs of whitespace in an image's alt text (a browser shows them as one
//   space, and a screen reader reads them as one);
// - newlines at the end of a code block or <pre>;
// - marks around a line break alone (`<em><br></em>`);
// - a paragraph of only spaces or `&nbsp;` and an empty one: both show as an
//   empty line (in the editor, an empty paragraph has the height of a line);
// - an empty document and one holding an empty paragraph: an empty editor
//   keeps one paragraph for the caret.
//
// With `alerts`, a quote that GitHub renders as an alert (`> [!NOTE]` on a
// line of its own, then content) becomes `<blockquote data-alert="note">`
// without that line, which is how render.ts writes the editor's callouts.

const BLOCK = new Set(
  (
    'address article aside blockquote body details dialog dd div dl dt fieldset figcaption figure footer form ' +
    'h1 h2 h3 h4 h5 h6 header hgroup hr html li main menu nav ol p pre section summary table tbody td tfoot th thead tr ul'
  ).split(' '),
);
const TRANSPARENT = new Set(['thead', 'tbody', 'tfoot']);
const LEAF = new Set(['br', 'img', 'input', 'wbr', 'embed', 'iframe', 'video', 'audio', 'object', 'canvas', 'svg', 'math']);
const MARK_NAME: Record<string, string> = { s: 'del', strike: 'del' };
/** Outermost first; any other element sorts between links and these. */
const MARK_RANK: Record<string, number> = { a: 0, strong: 2, b: 2, em: 3, i: 3, del: 4, code: 5 };
const ALERT = /^\[!(note|tip|important|warning|caution)\][ \t]*$/i;

export interface CanonicalOptions {
  /** Read GitHub alert syntax in quotes as GitHub does. */
  readonly alerts?: boolean;
}

export function canonicalHtml(html: string, options: CanonicalOptions = {}): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;
  if (options.alerts) for (const q of Array.from(root.querySelectorAll('blockquote'))) readAlert(q);
  const out = blocks(root, false);
  // An empty editor holds one empty paragraph, for the caret.
  return (out === '<p></p>' ? '' : out).replace(/></g, '>\n<');
}

function readAlert(quote: Element): void {
  const first = quote.firstElementChild;
  if (first?.tagName !== 'P') return;
  const head = first.firstChild;
  if (head?.nodeType !== 3) return;
  const value = (head as Text).data;
  const nl = value.indexOf('\n');
  const line = nl === -1 ? value : value.slice(0, nl);
  const m = ALERT.exec(line.trimStart());
  if (!m) return;
  const rest = nl === -1 ? '' : value.slice(nl + 1);
  // GitHub needs content after the marker line.
  const restOfParagraph = rest + Array.from(first.childNodes).slice(1).map((n) => n.textContent).join('');
  if (!restOfParagraph.trim() && !first.nextElementSibling && first.childNodes.length === 1) return;
  (head as Text).data = rest;
  if (nl === -1 && first.childNodes.length > 1 && first.childNodes[1]!.nodeName === 'BR') first.childNodes[1]!.remove();
  if (!first.textContent!.trim() && !first.querySelector('img')) first.remove();
  quote.setAttribute('data-alert', m[1]!.toLowerCase());
}

function isBlock(node: Node): boolean {
  return node.nodeType === 1 && BLOCK.has((node as Element).localName);
}

/** An element that is inline by name but holds blocks (such as raw `<a><div>`) is serialized as a block. */
function holdsBlocks(el: Element): boolean {
  return Array.from(el.querySelectorAll('*')).some((d) => BLOCK.has(d.localName));
}

function attrs(el: Element): string {
  const out: string[] = [];
  for (const { name, value } of Array.from(el.attributes)) {
    if (name === 'open' && el.localName === 'details') continue;
    let v = value;
    if (name === 'href' || name === 'src') v = decodeUrl(v);
    if (name === 'alt') v = v.replace(/\s+/g, ' ');
    out.push(v === '' ? name : `${name}="${escapeAttr(v)}"`);
  }
  out.sort();
  return out.length ? ' ' + out.join(' ') : '';
}

function decodeUrl(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

/** Block-level children: blocks as elements, and each run of inline content between them. */
function blocks(parent: ParentNode, inItem: boolean): string {
  let out = '';
  let run: Node[] = [];
  const flush = () => {
    const html = inline(run);
    run = [];
    if (html) out += inItem ? `<p>${html}</p>` : html;
  };
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 8) continue;
    if (isBlock(node) || (node.nodeType === 1 && !LEAF.has((node as Element).localName) && holdsBlocks(node as Element))) {
      flush();
      out += element(node as Element);
    } else run.push(node);
  }
  flush();
  return out;
}

function element(el: Element): string {
  const name = el.localName;
  if (TRANSPARENT.has(name)) return blocks(el, false);
  if (name === 'pre') return `<pre${attrs(el)}>${verbatim(el).replace(/\n+$/, '')}</pre>`;
  if (name === 'hr') return `<hr${attrs(el)}>`;
  // A paragraph of only spaces, such as `&nbsp;`, shows as an empty line, as an empty paragraph does in the editor.
  if (name === 'p' && !el.querySelector('img, input, br') && !el.textContent!.replace(/[\s\u00a0]/g, '')) return '<p></p>';
  const inner = name === 'td' || name === 'th' || name === 'p' || /^h[1-6]$/.test(name) || name === 'summary' ? inlineOrBlocks(el) : blocks(el, name === 'li');
  return `<${name}${attrs(el)}>${inner}</${name}>`;
}

/** A paragraph, heading or cell holds inline content, unless raw HTML put blocks in it. */
function inlineOrBlocks(el: Element): string {
  return Array.from(el.childNodes).some(isBlock) ? blocks(el, false) : inline(Array.from(el.childNodes));
}

/** <pre> content as written, with elements kept (such as <code>). */
function verbatim(node: Node): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) out += escapeText((child as Text).data);
    else if (child.nodeType === 1) {
      const el = child as Element;
      out += `<${el.localName}${attrs(el)}>${verbatim(el)}</${el.localName}>`;
    }
  }
  // A newline that ends the code inside <code> ends the block too.
  return out.replace(/\n+(<\/code>)$/, '$1');
}

/** The element name of a mark (`a href="u"` is `a`). */
const tagOf = (mark: string) => mark.split(' ')[0]!;

interface Leaf {
  /** Text, or the HTML of an element that holds no text (a line break, an image). */
  text: string;
  atom: boolean;
  marks: string[];
}

/** Inline nodes as leaves, each with the set of marks around it, in canonical nesting. */
function inline(nodes: Node[]): string {
  const leaves: Leaf[] = [];
  const walk = (node: Node, marks: string[]) => {
    if (node.nodeType === 3) {
      leaves.push({ text: (node as Text).data, atom: false, marks });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const name = MARK_NAME[el.localName] ?? el.localName;
    if (LEAF.has(name)) {
      leaves.push({ text: `<${name}${attrs(el)}>`, atom: true, marks });
      return;
    }
    if (isBlock(el) || holdsBlocks(el)) {
      leaves.push({ text: element(el), atom: true, marks });
      return;
    }
    const mark = `${name}${attrs(el)}`;
    const next = marks.includes(mark) ? marks : [...marks, mark];
    for (const child of Array.from(el.childNodes)) walk(child, next);
  };
  for (const node of nodes) walk(node, []);

  // Whitespace as a browser shows it.
  for (const leaf of leaves) if (!leaf.atom) leaf.text = leaf.text.replace(/[ \t\n\r\f]+/g, ' ');
  const isBreak = (l: Leaf | undefined) => !l || (l.atom && l.text.startsWith('<br'));
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i]!;
    if (leaf.atom) continue;
    const prev = leaves.slice(0, i).reverse().find((l) => l.atom || l.text !== '');
    if (isBreak(prev) || (prev && !prev.atom && prev.text.endsWith(' '))) leaf.text = leaf.text.replace(/^ /, '');
  }
  for (let i = leaves.length - 1; i >= 0; i--) {
    const leaf = leaves[i]!;
    if (leaf.atom) continue;
    const next = leaves.slice(i + 1).find((l) => l.atom || l.text !== '');
    if (isBreak(next)) leaf.text = leaf.text.replace(/ $/, '');
  }

  const rank = (mark: string) => MARK_RANK[tagOf(mark)] ?? 1;
  const kept = leaves
    .filter((l) => l.atom || l.text !== '')
    .map((l) => (l.atom && l.text.startsWith('<br') ? { ...l, marks: l.marks.filter((m) => tagOf(m) === 'a') } : l))
    .map((l) => ({ ...l, marks: [...l.marks].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0)) }));
  let out = '';
  const open: string[] = [];
  for (const leaf of kept) {
    let same = 0;
    while (same < open.length && same < leaf.marks.length && open[same] === leaf.marks[same]) same++;
    while (open.length > same) out += `</${tagOf(open.pop()!)}>`;
    for (const mark of leaf.marks.slice(same)) {
      out += `<${mark}>`;
      open.push(mark);
    }
    out += leaf.atom ? leaf.text : escapeText(leaf.text);
  }
  while (open.length) out += `</${tagOf(open.pop()!)}>`;
  return out;
}
