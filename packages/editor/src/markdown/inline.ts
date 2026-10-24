// Inline Markdown parser (CommonMark 0.31.2 section 6 and appendix A, plus GFM
// strikethrough).
//
// The parser scans a paragraph's text once, left to right. Most constructs
// (code spans, autolinks, raw HTML, entities, escapes) are recognized on the
// spot. Emphasis and links need lookahead, so their delimiters (`*`, `_`, `~`,
// `[`, `![`) are pushed as text nodes onto two stacks, and resolved when a
// `]` arrives (links) or at the end (emphasis), exactly as described in the
// spec's appendix. Nodes live in a doubly linked tree while parsing so that
// wrapping a range of siblings in a new node is cheap.

import type { Inline } from '../model';
import { type ImageNodeAlign, type InlineNode, type Positioned, type Range, type SyntaxRange, type TextNode, type TextPiece, imageSuffix, pieceEnd } from './ast';
import { lookupEntity } from '#entities';
import { lowerInlines } from './lower';
import { emailLiterals, isLiteralBoundary, urlLiteralAt } from './autolink';
import { type InlineSyntax, type MarkdownOptions, resolveMarkdown } from './options';

/** Link reference definitions, keyed by normalized label. */
export type RefMap = Map<string, { readonly destination: string; readonly title: string }>;

/**
 * Parses a paragraph's inline content into the document model. Link
 * reference definitions are not available here, so reference links stay text.
 */
export function parseInline(src: string, options?: MarkdownOptions): Inline {
  const o = resolveMarkdown(options);
  return lowerInlines(parseInlines(src, new Map(), o.inline, o.autolinks), options);
}

/**
 * Parses inline content to syntax tree nodes. `src` should already be
 * trimmed. `autolinks` turns on GFM autolink literals.
 */
export function parseInlines(src: string, refs: RefMap, syntax: readonly InlineSyntax[] = [], autolinks = false): InlineNode[] {
  // Most headings, list items and short paragraphs are plain text, which the
  // parser would return as one text node. Skip it for those.
  if (isPlain(src, syntax, autolinks)) return src ? [{ type: 'text', value: src, pos: { from: 0, to: src.length } }] : [];
  const nodes = new InlineParser(src, refs, syntax, autolinks).parse();
  return autolinks ? linkEmails(nodes) : nodes;
}

/**
 * E-mail autolink literals, found in the final text nodes outside links (as
 * cmark-gfm does), so a local part may hold "_" that the parser saw as a
 * possible delimiter.
 */
/** No character that can start CommonMark inline syntax. */
const rePlain = /^[^\n`[\]\\!<&*_~]*$/;
/** What can start a GFM autolink literal: `www.`, a scheme, or an e-mail's `@`. */
const reLiteralStart = /www\.|:\/\/|@/i;

function isPlain(src: string, syntax: readonly InlineSyntax[], autolinks: boolean): boolean {
  if (!rePlain.test(src) || (autolinks && reLiteralStart.test(src))) return false;
  for (const s of syntax) for (const ch of s.triggers) if (src.includes(ch)) return false;
  return true;
}

function linkEmails(nodes: InlineNode[]): InlineNode[] {
  let changed = false;
  const out: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      const found = emailLiterals(node.value);
      if (found.length === 0) {
        out.push(node);
        continue;
      }
      changed = true;
      let pos = 0;
      for (const { from, to } of found) {
        if (from > pos) out.push(sliceText(node, pos, from));
        const email = sliceText(node, from, to);
        const link: InlineNode = { type: 'link', destination: 'mailto:' + email.value, title: '', children: [email] };
        out.push(email.pos ? { ...link, pos: email.pos, syntax: [{ kind: 'dest', ...email.pos }] } : link);
        pos = to;
      }
      if (pos < node.value.length) out.push(sliceText(node, pos, node.value.length));
    } else if (node.type === 'emphasis' || node.type === 'strong' || node.type === 'strike') {
      const children = linkEmails(node.children);
      if (children !== node.children) changed = true;
      out.push(children === node.children ? node : { ...node, children });
    } else {
      out.push(node);
    }
  }
  return changed ? out : nodes;
}

/** The text node for `value.slice(a, b)` of a text node, with its part of the node's range and pieces. */
function sliceText(node: TextNode, a: number, b: number): TextNode {
  const value = node.value.slice(a, b);
  if (!node.pos) return { type: 'text', value };
  if (!node.pieces) return { type: 'text', value, pos: { from: node.pos.from + a, to: node.pos.from + b } };
  const pieces: TextPiece[] = [];
  // Only the pieces that reach into [a, b): the slices of one node move forward, so this stays linear.
  for (let i = pieceIndex(node.pieces, a); i < node.pieces.length && node.pieces[i]!.at < b; i++) {
    const p = node.pieces[i]!;
    const from = Math.max(p.at, a);
    const to = Math.min(pieceEnd(p), b);
    if (to > from) pieces.push({ at: from - a, from: p.from + (from - p.at), to: p.from + (to - p.at) });
  }
  const pos = { from: pieceOffset(node, a), to: pieceOffset(node, b) };
  return { type: 'text', value, pos, ...(verbatim(pieces, value, pos) ? {} : { pieces }) };
}

/** The index of the first piece that ends at or after value offset `k`, or the number of pieces. */
function pieceIndex(pieces: readonly TextPiece[], k: number): number {
  let lo = 0;
  let hi = pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pieceEnd(pieces[mid]!) < k) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Where offset `k` of a text node's value is in the parsed text: its place in
 * the verbatim piece holding it, or, in text not written as such, the end of
 * that text.
 */
function pieceOffset(node: TextNode, k: number): number {
  const p = node.pieces![pieceIndex(node.pieces!, k)];
  if (!p) return node.pos!.to;
  return k < p.at ? p.from : p.from + (k - p.at);
}

/** True when the pieces say the value is one verbatim slice of `pos`, so they need not be kept. */
function verbatim(pieces: readonly TextPiece[], value: string, pos: Range): boolean {
  const p = pieces[0];
  return pieces.length === 1 && p!.at === 0 && p!.from === pos.from && p!.to === pos.to && value.length === pos.to - pos.from;
}

/** Appends a following text's pieces, moved by `shift` in the value; a piece that follows the last one in both the value and the parsed text joins it. */
function appendPieces(out: TextPiece[], after: readonly TextPiece[], shift: number): void {
  for (const p of after) {
    const at = p.at + shift;
    const last = out[out.length - 1];
    if (last && pieceEnd(last) === at && last.to === p.from) out[out.length - 1] = { ...last, to: p.to };
    else out.push({ at, from: p.from, to: p.to });
  }
}

// ---------------------------------------------------------------------------
// Character classes and shared patterns

const C_TAB = 9;
const C_NEWLINE = 10;
const C_SPACE = 32;
const C_BANG = 33;
const C_AMP = 38;
const C_OPEN_PAREN = 40;
const C_CLOSE_PAREN = 41;
const C_ASTERISK = 42;
const C_COLON = 58;
const C_LESSTHAN = 60;
const C_OPEN_BRACKET = 91;
const C_BACKSLASH = 92;
const C_CLOSE_BRACKET = 93;
const C_UNDERSCORE = 95;
const C_BACKTICK = 96;
const C_TILDE = 126;

const ESCAPABLE = '[!"#$%&\'()*+,./:;<=>?@[\\\\\\]^_`{|}~-]';
const reEscapable = new RegExp('^' + ESCAPABLE);
const ENTITY = '&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});';
const reEntityHere = new RegExp(ENTITY, 'y');
const reEntityOrEscapedChar = new RegExp('\\\\' + ESCAPABLE + '|' + ENTITY, 'g');

const TAGNAME = '[A-Za-z][A-Za-z0-9-]*';
const ATTRIBUTENAME = '[a-zA-Z_:][a-zA-Z0-9:._-]*';
const UNQUOTEDVALUE = '[^"\'=<>`\\x00-\\x20]+';
const ATTRIBUTEVALUE = `(?:${UNQUOTEDVALUE}|'[^']*'|"[^"]*")`;
const ATTRIBUTE = `(?:[ \\t\\n]+${ATTRIBUTENAME}(?:[ \\t\\n]*=[ \\t\\n]*${ATTRIBUTEVALUE})?)`;
/** An open tag, as defined in the spec's "Raw HTML" section. Shared with the HTML block rules. */
export const OPENTAG = `<${TAGNAME}${ATTRIBUTE}*[ \\t\\n]*/?>`;
export const CLOSETAG = `</${TAGNAME}[ \\t\\n]*>`;
const HTMLCOMMENT = '<!-->|<!--->|<!--[\\s\\S]*?-->';
const PROCESSINGINSTRUCTION = '<\\?[\\s\\S]*?\\?>';
const DECLARATION = '<![A-Za-z][^>]*>';
const CDATA = '<!\\[CDATA\\[[\\s\\S]*?\\]\\]>';
const reHtmlTag = new RegExp(
  `(?:${OPENTAG}|${CLOSETAG}|${HTMLCOMMENT}|${PROCESSINGINSTRUCTION}|${DECLARATION}|${CDATA})`,
  'y',
);

/** The URI and e-mail address of an autolink (`<…>`), as regular expression sources. The serializer uses them too. */
export const AUTOLINK_URI = '[A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\\x00-\\x20]*';
export const AUTOLINK_EMAIL =
  "[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*";
const reAutolink = new RegExp(`<(${AUTOLINK_URI})>`, 'y');
const reEmailAutolink = new RegExp(`<(${AUTOLINK_EMAIL})>`, 'y');
const reLinkTitle = /"(?:\\[\s\S]|[^\\"\x00])*"|'(?:\\[\s\S]|[^\\'\x00])*'|\((?:\\[\s\S]|[^\\()\x00])*\)/y;
const reLinkDestinationBraces = /<(?:[^<>\n\\\x00]|\\.)*>/y;
const reLinkLabel = /\[(?:[^\\[\]]|\\[\s\S]){0,1000}\]/y;
const reSpnl = /[ \t]*(?:\n[ \t]*)?/y;
const reSpaceAtEndOfLine = /[ \t]*(?:\n|$)/y;
/** A run of characters that cannot start any inline construct. */
const reMain = /[^\n`[\]\\!<&*_~]+/y;
const reBackticks = /`+/y;

const reUnicodeWhitespace = /[\t\n\f\r\p{Zs}]/u;
const reUnicodePunctuation = /[\p{P}\p{S}]/u;

/** Unicode whitespace as the spec defines it (Zs plus tab, LF, FF, CR). */
export function isUnicodeWhitespace(ch: string): boolean {
  return reUnicodeWhitespace.test(ch);
}

/** Unicode punctuation as the spec defines it (categories P and S). */
export function isUnicodePunctuation(ch: string): boolean {
  return reUnicodePunctuation.test(ch);
}

/** Decodes one entity reference such as `&amp;` or `&#x41;`. Returns null if it is not a valid one. */
function decodeEntity(entity: string): string | null {
  if (entity[1] === '#') {
    const hex = entity[2] === 'x' || entity[2] === 'X';
    const code = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    // Code point 0, surrogates and values beyond Unicode become U+FFFD.
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(code);
  }
  return lookupEntity(entity.slice(1, -1)) ?? null;
}

const reEntity = new RegExp(ENTITY, 'g');

/** Decodes the entity references in HTML text, such as a section title. */
export function decodeEntities(s: string): string {
  return s.includes('&') ? s.replace(reEntity, (m) => decodeEntity(m) ?? m) : s;
}

/** Applies backslash escapes and entities, for link destinations, titles and info strings. */
export function unescapeString(s: string): string {
  if (!s.includes('\\') && !s.includes('&')) return s;
  return s.replace(reEntityOrEscapedChar, (m) => (m[0] === '\\' ? m[1]! : (decodeEntity(m) ?? m)));
}

/**
 * Normalizes a link label for matching: strips the brackets, collapses
 * whitespace and case-folds. `toLowerCase().toUpperCase()` approximates
 * Unicode case folding well enough for the spec (for example "ẞ" and "SS").
 */
function normalizeLabel(label: string): string {
  return label
    .slice(1, -1)
    .replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
    .replace(/[ \t\r\n]+/g, ' ')
    .toLowerCase()
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// Mutable tree used while parsing

type NodeType = InlineNode['type'] | 'root';

class Node {
  value = '';
  /** Syntax name of a token. */
  name = '';
  /** Nesting depth of the subtree (0 for leaves). */
  depth = 0;
  destination = '';
  title = '';
  /** An image's alignment (see `imageSuffix`), '' when none. */
  align: ImageNodeAlign | '' = '';
  /** An image's size (see `imageSuffix`), 0 when none. */
  width = 0;
  height = 0;
  /** An escaped "@": kept apart from the text around it, so it does not join an e-mail literal. */
  apart = false;
  /** The node's range in the subject. A delimiter run's shrinks as emphasis uses it up. */
  from: number;
  to: number;
  /** A text node written as an escape or entity: nothing in its range is verbatim. */
  escaped = false;
  syntax: SyntaxRange[] | null = null;
  /** A code span's text range. */
  content: Range | null = null;
  parent: Node | null = null;
  first: Node | null = null;
  last: Node | null = null;
  prev: Node | null = null;
  next: Node | null = null;

  constructor(
    public type: NodeType,
    from = 0,
    to = from,
    value = '',
  ) {
    this.value = value;
    this.from = from;
    this.to = to;
  }

  append(child: Node): void {
    child.unlink();
    child.parent = this;
    if (child.depth >= this.depth) this.depth = child.depth + 1;
    if (this.last) {
      this.last.next = child;
      child.prev = this.last;
      this.last = child;
    } else {
      this.first = this.last = child;
    }
  }

  insertAfter(sibling: Node): void {
    sibling.unlink();
    sibling.next = this.next;
    if (sibling.next) sibling.next.prev = sibling;
    sibling.prev = this;
    this.next = sibling;
    sibling.parent = this.parent;
    if (this.parent && !sibling.next) this.parent.last = sibling;
  }

  unlink(): void {
    if (this.prev) this.prev.next = this.next;
    else if (this.parent) this.parent.first = this.next;
    if (this.next) this.next.prev = this.prev;
    else if (this.parent) this.parent.last = this.prev;
    this.parent = this.prev = this.next = null;
  }
}

/**
 * Emphasis and links nested deeper than this stay literal text. Not part of
 * the spec: it keeps absurd input (thousands of "*") from exhausting the
 * stack in the recursive tree walks.
 */
const MAX_INLINE_NESTING = 100;

/** The deepest subtree among the siblings after `from`, up to `to` (exclusive). */
function innerDepth(from: Node, to: Node | null): number {
  let depth = 0;
  for (let n = from.next; n && n !== to && depth < MAX_INLINE_NESTING; n = n.next) if (n.depth >= depth) depth = n.depth + 1;
  return depth;
}

/**
 * Text written as a backslash escape or an entity, covering `[from, to)` of
 * the subject with nothing verbatim in it (the gaps between a text node's
 * pieces are its escapes and entities). As in cmark-gfm, `a\@b.com` and
 * `a&#64;b.com` are not e-mail links.
 */
function escapedText(value: string, from: number, to: number): Node {
  const text = new Node('text', from, to, value);
  text.escaped = true;
  text.apart = value === '@';
  return text;
}

/** Adds a tree node's position fields to the AST node just made for it. */
function positioned<T extends object>(n: Node, node: T): T & Positioned {
  const out = node as T & { pos?: Range; syntax?: readonly SyntaxRange[] };
  out.pos = { from: n.from, to: n.to };
  if (n.syntax) out.syntax = n.syntax;
  return out;
}

function textNode(n: Node): TextNode {
  const pos = { from: n.from, to: n.to };
  return n.escaped ? { type: 'text', value: n.value, pos, pieces: [] } : { type: 'text', value: n.value, pos };
}

/**
 * Two adjacent text nodes as one, keeping where each part of the value is.
 * `prev` is a node this conversion made, so its pieces are appended to in
 * place: a text with thousands of escapes merges in constant time each.
 */
function mergeText(prev: TextNode, n: Node): TextNode {
  const value = prev.value + n.value;
  const pos = { from: prev.pos!.from, to: n.to };
  // Most merges join two plain runs that follow each other: one verbatim slice, nothing to keep.
  if (!prev.pieces && !n.escaped && prev.pos!.to === n.from && n.value.length === n.to - n.from) return { type: 'text', value, pos };
  const pieces = (prev.pieces as TextPiece[] | undefined) ?? [{ at: 0, from: prev.pos!.from, to: prev.pos!.to }];
  appendPieces(pieces, n.escaped ? [] : [{ at: 0, from: n.from, to: n.to }], prev.value.length);
  return verbatim(pieces, value, pos) ? { type: 'text', value, pos } : { type: 'text', value, pos, pieces };
}

/** Converts the mutable tree to plain AST nodes, merging adjacent text nodes. */
function toAst(parent: Node): InlineNode[] {
  const out: InlineNode[] = [];
  let apart = false;
  for (let n = parent.first; n; n = n.next) {
    switch (n.type) {
      case 'text': {
        if (n.value === '') break;
        const prev = out[out.length - 1];
        if (prev?.type === 'text' && !apart && !n.apart) out[out.length - 1] = mergeText(prev, n);
        else out.push(textNode(n));
        apart = n.apart;
        break;
      }
      case 'softBreak':
      case 'hardBreak':
        out.push(positioned(n, { type: n.type }));
        break;
      case 'code':
        out.push(positioned(n, n.content ? { type: n.type, value: n.value, content: n.content } : { type: n.type, value: n.value }));
        break;
      case 'html':
        out.push(positioned(n, { type: n.type, value: n.value }));
        break;
      case 'token':
        out.push(positioned(n, { type: 'token', name: n.name, value: n.value }));
        break;
      case 'emphasis':
      case 'strong':
      case 'strike':
        out.push(positioned(n, { type: n.type, children: toAst(n) }));
        break;
      case 'link':
        out.push(positioned(n, { type: n.type, destination: n.destination, title: n.title, children: toAst(n) }));
        break;
      case 'image': {
        out.push(
          positioned(n, {
            type: n.type,
            destination: n.destination,
            title: n.title,
            children: toAst(n),
            ...(n.align ? { align: n.align } : {}),
            ...(n.width ? { width: n.width } : {}),
            ...(n.width && n.height ? { height: n.height } : {}),
          }),
        );
        break;
      }
      case 'root':
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delimiter and bracket stacks

interface Delimiter {
  /** Character code of `*`, `_` or `~`. */
  cc: number;
  /** Delimiters not used up yet. */
  count: number;
  /** Length of the original run, for the "rule of three". */
  origCount: number;
  node: Node;
  canOpen: boolean;
  canClose: boolean;
  prev: Delimiter | null;
  next: Delimiter | null;
}

interface Bracket {
  node: Node;
  prev: Bracket | null;
  /** Top of the delimiter stack when the bracket was pushed. */
  prevDelimiter: Delimiter | null;
  /** Position of the `[` in the subject. */
  index: number;
  image: boolean;
  /** False once a link was formed around it (links may not contain links). */
  active: boolean;
  /** True if another bracket opened after this one, so it cannot be a shortcut reference. */
  bracketAfter: boolean;
}

// ---------------------------------------------------------------------------
// Parser

class InlineParser {
  private pos = 0;
  private delimiters: Delimiter | null = null;
  private brackets: Bracket | null = null;
  /**
   * For each backtick run length, a position after which no run of that
   * length exists. Avoids quadratic rescanning for unmatched backticks.
   */
  private backticksAfter = new Map<number, number>();
  /** Per opening quote character, a position from which no link title can close. */
  private titleFailedFrom = new Map<string, number>();
  /** The last index of each end of raw HTML (`-->`, `?>`, `]]>`, `>`) in the subject, found once. */
  private lastEnds = new Map<string, number>();
  /** Where the last destination and title parsed were written, set by `parseLinkDestination` and `parseLinkTitle`. */
  private destRange: Range | null = null;
  private titleRange: Range | null = null;

  /** Inline syntax extensions by trigger character code. */
  private readonly triggers = new Map<number, InlineSyntax[]>();
  /** A run of characters that cannot start any construct, including extension triggers. */
  private readonly reText: RegExp = reMain;

  constructor(
    private readonly subject: string,
    private readonly refs: RefMap,
    syntax: readonly InlineSyntax[],
    private readonly autolinks = false,
  ) {
    for (const s of syntax) {
      for (const ch of s.triggers) {
        const code = ch.charCodeAt(0);
        this.triggers.set(code, [...(this.triggers.get(code) ?? []), s]);
      }
    }
    if (this.triggers.size > 0) {
      const extra = [...this.triggers.keys()].map((c) => '\\u' + c.toString(16).padStart(4, '0')).join('');
      this.reText = new RegExp(reMain.source.replace(/\]\+$/, extra + ']+'), 'y');
    }
  }

  parse(): InlineNode[] {
    const root = new Node('root');
    while (this.pos < this.subject.length) this.parseOne(root);
    this.processEmphasis(null);
    return toAst(root);
  }

  private peek(offset = 0): number {
    const c = this.subject.charCodeAt(this.pos + offset);
    return Number.isNaN(c) ? -1 : c;
  }

  /** Matches a sticky regex at the current position and advances past it. */
  private match(re: RegExp): RegExpExecArray | null {
    re.lastIndex = this.pos;
    const m = re.exec(this.subject);
    if (m) this.pos = re.lastIndex;
    return m;
  }

  /** A text node holding `[from, to)` of the subject as written. */
  private text(from: number, to: number): Node {
    return new Node('text', from, to, this.subject.slice(from, to));
  }

  private parseOne(block: Node): void {
    const c = this.peek();
    if (this.triggers.size > 0 && this.parseToken(c, block)) return;
    let handled = false;
    switch (c) {
      case C_NEWLINE:
        handled = this.parseNewline(block);
        break;
      case C_BACKSLASH:
        handled = this.parseBackslash(block);
        break;
      case C_BACKTICK:
        handled = this.parseBackticks(block);
        break;
      case C_ASTERISK:
      case C_UNDERSCORE:
      case C_TILDE:
        handled = this.handleDelim(c, block);
        break;
      case C_OPEN_BRACKET:
        handled = this.parseOpenBracket(block);
        break;
      case C_BANG:
        handled = this.parseBang(block);
        break;
      case C_CLOSE_BRACKET:
        handled = this.parseCloseBracket(block);
        break;
      case C_LESSTHAN:
        handled = this.parseAutolink(block) || this.parseHtmlTag(block);
        break;
      case C_AMP:
        handled = this.parseEntity(block);
        break;
      default:
        handled = this.parseString(block);
    }
    if (!handled) {
      this.pos += 1;
      block.append(new Node('text', this.pos - 1, this.pos, String.fromCharCode(c)));
    }
  }

  /** An inline syntax extension's token at the current position. */
  private parseToken(c: number, block: Node): boolean {
    const syntaxes = this.triggers.get(c);
    if (!syntaxes) return false;
    for (const s of syntaxes) {
      const end = s.match(this.subject, this.pos);
      if (end > this.pos) {
        const node = new Node('token', this.pos, end, this.subject.slice(this.pos, end));
        node.name = s.name;
        block.append(node);
        this.pos = end;
        return true;
      }
    }
    return false;
  }

  private parseString(block: Node): boolean {
    const start = this.pos;
    const m = this.match(this.reText);
    if (!m) return false;
    // GFM autolink literals, not inside link text (as in cmark-gfm). A URL
    // may run past the text run, over characters such as "_" and "&".
    if (this.autolinks && !this.brackets && /www\.|:\/\//i.test(m[0])) {
      const reCandidate = /www\.|(?:https?|ftp):\/\//gi;
      for (const c of m[0].matchAll(reCandidate)) {
        const at = start + c.index!;
        if (!isLiteralBoundary(this.subject[at - 1], c[0].toLowerCase() === 'www.')) continue;
        const url = urlLiteralAt(this.subject, at);
        if (!url) continue;
        if (at > start) block.append(this.text(start, at));
        const link = new Node('link', at, url.end);
        link.destination = url.href;
        link.syntax = [{ kind: 'dest', from: at, to: url.end }];
        link.append(this.text(at, url.end));
        block.append(link);
        this.pos = url.end;
        return true;
      }
    }
    block.append(new Node('text', start, this.pos, m[0]));
    return true;
  }

  /**
   * A line ending: a hard break after two or more spaces, otherwise a soft
   * break. The break's range runs from the spaces before it over the next
   * line's indentation.
   */
  private parseNewline(block: Node): boolean {
    let from = this.pos;
    this.pos += 1;
    const last = block.last;
    let hard = false;
    if (last && last.type === 'text' && last.value.endsWith(' ')) {
      hard = last.value.endsWith('  ');
      const trimmed = last.value.replace(/ +$/, '');
      const n = last.value.length - trimmed.length;
      last.value = trimmed;
      // The spaces were written as such: the text's range gives them up.
      if (!last.escaped) {
        last.to -= n;
        from = last.to;
      }
    }
    const brk = new Node(hard ? 'hardBreak' : 'softBreak', from);
    block.append(brk);
    this.skipLineStart();
    brk.to = this.pos;
    return true;
  }

  /** Leading spaces and tabs of a continuation line are not part of the content. */
  private skipLineStart(): void {
    let c = this.peek();
    while (c === C_SPACE || c === C_TAB) {
      this.pos += 1;
      c = this.peek();
    }
  }

  private parseBackslash(block: Node): boolean {
    const start = this.pos;
    this.pos += 1;
    const c = this.peek();
    if (c === C_NEWLINE) {
      this.pos += 1;
      const brk = new Node('hardBreak', start);
      block.append(brk);
      this.skipLineStart();
      brk.to = this.pos;
    } else if (c !== -1 && reEscapable.test(this.subject[this.pos]!)) {
      block.append(escapedText(this.subject[this.pos]!, start, start + 2));
      this.pos += 1;
    } else {
      block.append(new Node('text', start, start + 1, '\\'));
    }
    return true;
  }

  private parseBackticks(block: Node): boolean {
    const start = this.pos;
    const ticks = this.match(reBackticks)![0];
    const n = ticks.length;
    const afterOpen = this.pos;
    const noneAfter = this.backticksAfter.get(n);
    if (noneAfter === undefined || afterOpen < noneAfter) {
      let m: RegExpExecArray | null;
      while ((m = this.match(reBackticks)) || this.findNextBacktick()) {
        if (!m) continue;
        if (m[0].length === n) {
          const closeFrom = this.pos - n;
          let code = this.subject.slice(afterOpen, closeFrom).replace(/\n/g, ' ');
          let strip = 0;
          if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) {
            code = code.slice(1, -1);
            strip = 1;
          }
          const node = new Node('code', start, this.pos, code);
          node.syntax = [
            { kind: 'open', from: start, to: afterOpen },
            { kind: 'close', from: closeFrom, to: this.pos },
          ];
          node.content = { from: afterOpen + strip, to: closeFrom - strip };
          block.append(node);
          return true;
        }
      }
      this.backticksAfter.set(n, afterOpen);
    }
    // No matching closer: the run is literal text.
    this.pos = afterOpen;
    block.append(this.text(start, afterOpen));
    return true;
  }

  /** Moves to the next backtick. Returns false at the end of the subject. */
  private findNextBacktick(): boolean {
    const i = this.subject.indexOf('`', this.pos);
    if (i < 0) {
      this.pos = this.subject.length;
      return false;
    }
    this.pos = i;
    return true;
  }

  private parseAutolink(block: Node): boolean {
    const start = this.pos;
    let m = this.match(reEmailAutolink);
    if (m) {
      this.autolink(block, start, 'mailto:' + m[1]!);
      return true;
    }
    m = this.match(reAutolink);
    if (m) {
      this.autolink(block, start, m[1]!);
      return true;
    }
    return false;
  }

  /** An autolink from `start` to the current position: `<` and `>` around text that is its own destination. */
  private autolink(block: Node, start: number, destination: string): void {
    const link = new Node('link', start, this.pos);
    link.destination = destination;
    link.syntax = [
      { kind: 'open', from: start, to: start + 1 },
      { kind: 'dest', from: start + 1, to: this.pos - 1 },
      { kind: 'close', from: this.pos - 1, to: this.pos },
    ];
    link.append(this.text(start + 1, this.pos - 1));
    block.append(link);
  }

  private parseHtmlTag(block: Node): boolean {
    // A comment, processing instruction, CDATA section or declaration whose
    // end is nowhere after it cannot match. Checking first keeps `<!--<!--…`
    // linear: the pattern would scan to the end of the text at each one.
    const s = this.subject;
    const p = this.pos;
    if (s.startsWith('<!--', p)) {
      if (this.lastEnd('-->') < p + 2) return false;
    } else if (s.startsWith('<?', p)) {
      if (this.lastEnd('?>') < p + 1) return false;
    } else if (s.startsWith('<![CDATA[', p)) {
      if (this.lastEnd(']]>') < p + 9) return false;
    } else if (s.startsWith('<!', p) && this.lastEnd('>') < p) {
      return false;
    }
    const m = this.match(reHtmlTag);
    if (!m) return false;
    block.append(new Node('html', p, this.pos, m[0]));
    return true;
  }

  private lastEnd(end: string): number {
    let at = this.lastEnds.get(end);
    if (at === undefined) {
      at = this.subject.lastIndexOf(end);
      this.lastEnds.set(end, at);
    }
    return at;
  }

  private parseEntity(block: Node): boolean {
    const start = this.pos;
    const m = this.match(reEntityHere);
    if (m) {
      const decoded = decodeEntity(m[0]);
      if (decoded !== null) {
        block.append(escapedText(decoded, start, this.pos));
        return true;
      }
      this.pos = start;
    }
    return false;
  }

  // -- Emphasis -------------------------------------------------------------

  /** Scans a delimiter run and pushes it onto the delimiter stack if it can open or close. */
  private handleDelim(cc: number, block: Node): boolean {
    const start = this.pos;
    while (this.peek() === cc) this.pos += 1;
    const count = this.pos - start;

    const before = start === 0 ? '\n' : charBefore(this.subject, start);
    const after = this.pos >= this.subject.length ? '\n' : charAt(this.subject, this.pos);
    const afterWs = isUnicodeWhitespace(after);
    const afterPunct = isUnicodePunctuation(after);
    const beforeWs = isUnicodeWhitespace(before);
    const beforePunct = isUnicodePunctuation(before);
    const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
    const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);

    let canOpen = leftFlanking;
    let canClose = rightFlanking;
    if (cc !== C_TILDE) {
      // As in micromark and cmark-gfm, a `*` or `_` run next to a `~`
      // counts as flanking on that side, so the closing `***` in
      // `***~~a~~***b` closes.
      if (after === '~') canOpen = true;
      if (before === '~') canClose = true;
    }
    if (cc === C_UNDERSCORE) {
      const open = canOpen;
      canOpen = open && (beforeWs || beforePunct || !canClose);
      canClose = canClose && (afterWs || afterPunct || !open);
    }
    // GFM strikethrough uses runs of one or two tildes only.
    if (cc === C_TILDE && count > 2) canOpen = canClose = false;

    const node = this.text(start, this.pos);
    block.append(node);
    if (canOpen || canClose) {
      const d: Delimiter = {
        cc,
        count,
        origCount: count,
        node,
        canOpen,
        canClose,
        prev: this.delimiters,
        next: null,
      };
      if (d.prev) d.prev.next = d;
      this.delimiters = d;
    }
    return true;
  }

  private removeDelimiter(d: Delimiter): void {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
    else this.delimiters = d.prev; // top of the stack
  }

  /** The "process emphasis" procedure of the spec's appendix, above `bottom`. */
  private processEmphasis(bottom: Delimiter | null): void {
    // Lower bounds for opener searches, per closer kind, so that failed
    // searches are not repeated (keeps the algorithm linear).
    const openersBottom = new Map<number, Delimiter | null>();

    let closer = this.delimiters;
    // (Stop at the bottom itself: then nothing is above it. Walking past it
    // would make every link in a long paragraph cost a full stack walk.)
    while (closer && closer !== bottom && closer.prev !== bottom) closer = closer.prev;
    if (closer === bottom) closer = null;

    while (closer) {
      if (!closer.canClose) {
        closer = closer.next;
        continue;
      }
      const key =
        closer.cc === C_TILDE
          ? 100 + closer.count
          : closer.cc * 10 + (closer.canOpen ? 3 : 0) + (closer.origCount % 3);
      const limit = openersBottom.has(key) ? openersBottom.get(key)! : bottom;

      let opener = closer.prev;
      let found = false;
      while (opener && opener !== bottom && opener !== limit) {
        if (opener.cc === closer.cc && opener.canOpen) {
          if (closer.cc === C_TILDE) {
            if (opener.count === closer.count) {
              found = true;
              break;
            }
          } else {
            const oddMatch =
              (closer.canOpen || opener.canClose) &&
              closer.origCount % 3 !== 0 &&
              (opener.origCount + closer.origCount) % 3 === 0;
            if (!oddMatch) {
              found = true;
              break;
            }
          }
        }
        opener = opener.prev;
      }

      const oldCloser = closer;
      if (found && opener) {
        const use = closer.cc === C_TILDE ? closer.count : closer.count >= 2 && opener.count >= 2 ? 2 : 1;
        const type = closer.cc === C_TILDE ? 'strike' : use === 1 ? 'emphasis' : 'strong';
        const openerNode = opener.node;
        const closerNode = closer.node;
        opener.count -= use;
        closer.count -= use;
        // Beyond the nesting limit the delimiters stay literal text.
        const literal = innerDepth(openerNode, closerNode) >= MAX_INLINE_NESTING;
        if (literal) {
          // Content around these delimiters is too deep too. Marking them so
          // stops the next search at them: `*a **a *a …` stays linear.
          openerNode.depth = closerNode.depth = MAX_INLINE_NESTING;
        } else {
          // The delimiters used are the innermost: the opener's last and the closer's first.
          openerNode.value = openerNode.value.slice(0, openerNode.value.length - use);
          closerNode.value = closerNode.value.slice(0, closerNode.value.length - use);
          openerNode.to -= use;
          closerNode.from += use;
          const wrapper = new Node(type, openerNode.to, closerNode.from);
          wrapper.syntax = [
            { kind: 'open', from: wrapper.from, to: wrapper.from + use },
            { kind: 'close', from: wrapper.to - use, to: wrapper.to },
          ];
          let n = openerNode.next;
          while (n && n !== closerNode) {
            const next: Node | null = n.next;
            wrapper.append(n);
            n = next;
          }
          openerNode.insertAfter(wrapper);
        }

        // Delimiters between opener and closer can no longer match anything.
        if (opener.next !== closer) {
          opener.next = closer;
          closer.prev = opener;
        }
        if (opener.count === 0) {
          if (!literal) openerNode.unlink();
          this.removeDelimiter(opener);
        }
        if (closer.count === 0) {
          if (!literal) closerNode.unlink();
          const next = closer.next;
          this.removeDelimiter(closer);
          closer = next;
        }
      } else {
        closer = closer.next;
        openersBottom.set(key, oldCloser.prev);
        // A closer that cannot open is useless once no opener matched it.
        if (!oldCloser.canOpen) this.removeDelimiter(oldCloser);
      }
    }

    while (this.delimiters && this.delimiters !== bottom) this.removeDelimiter(this.delimiters);
  }

  // -- Links and images -----------------------------------------------------

  private pushBracket(node: Node, index: number, image: boolean): void {
    if (this.brackets) this.brackets.bracketAfter = true;
    this.brackets = {
      node,
      prev: this.brackets,
      prevDelimiter: this.delimiters,
      index,
      image,
      active: true,
      bracketAfter: false,
    };
  }

  private parseOpenBracket(block: Node): boolean {
    const start = this.pos;
    this.pos += 1;
    const node = new Node('text', start, start + 1, '[');
    block.append(node);
    this.pushBracket(node, start, false);
    return true;
  }

  private parseBang(block: Node): boolean {
    const start = this.pos;
    this.pos += 1;
    if (this.peek() === C_OPEN_BRACKET) {
      this.pos += 1;
      const node = new Node('text', start, start + 2, '![');
      block.append(node);
      this.pushBracket(node, start + 1, true);
    } else {
      block.append(new Node('text', start, start + 1, '!'));
    }
    return true;
  }

  private parseCloseBracket(block: Node): boolean {
    this.pos += 1;
    const startPos = this.pos;
    const opener = this.brackets;
    if (!opener) {
      block.append(new Node('text', startPos - 1, startPos, ']'));
      return true;
    }
    if (!opener.active) {
      block.append(new Node('text', startPos - 1, startPos, ']'));
      this.brackets = opener.prev;
      return true;
    }

    let dest: string | null = null;
    let title: string | null = null;
    let destRange: Range | null = null;
    let titleRange: Range | null = null;
    let matched = false;

    // Inline link: [text](destination "title")
    if (this.peek() === C_OPEN_PAREN) {
      this.pos += 1;
      this.spnl();
      dest = this.parseLinkDestination();
      if (dest !== null) {
        const beforeTitle = this.pos;
        this.spnl();
        // A title must be separated from the destination by whitespace.
        if (this.pos !== beforeTitle) title = this.parseLinkTitle();
        this.spnl();
        if (this.peek() === C_CLOSE_PAREN) {
          this.pos += 1;
          matched = true;
          destRange = this.destRange;
          if (title !== null) titleRange = this.titleRange;
        }
      }
      if (!matched) this.pos = startPos;
    }

    // Reference link: full [text][label], collapsed [text][] or shortcut [text].
    if (!matched) {
      const beforeLabel = this.pos;
      const n = this.parseLinkLabel();
      let label: string | null = null;
      if (n > 2) label = this.subject.slice(beforeLabel, beforeLabel + n);
      else if (!opener.bracketAfter) label = this.subject.slice(opener.index, startPos);
      if (n === 0) this.pos = startPos;
      if (label !== null && label.length <= 1001) {
        const ref = this.refs.get(normalizeLabel(label));
        if (ref) {
          dest = ref.destination;
          title = ref.title;
          matched = true;
        }
      }
    }

    if (!matched || innerDepth(opener.node, null) >= MAX_INLINE_NESTING) {
      this.brackets = opener.prev;
      this.pos = startPos;
      block.append(new Node('text', startPos - 1, startPos, ']'));
      return true;
    }

    const link = new Node(opener.image ? 'image' : 'link', opener.node.from, this.pos);
    link.destination = dest ?? '';
    link.title = title ?? '';
    const syntax: SyntaxRange[] = [
      { kind: 'open', from: opener.node.from, to: opener.node.to },
      { kind: 'close', from: startPos - 1, to: startPos },
    ];
    if (this.pos > startPos) syntax.push({ kind: 'tail', from: startPos, to: this.pos });
    if (destRange) syntax.push({ kind: 'dest', ...destRange });
    if (titleRange) syntax.push({ kind: 'title', ...titleRange });
    link.syntax = syntax;
    if (opener.image) {
      // An alignment and a size after the description, `![alt|center|320](src)`.
      const suffix = imageSuffix(this.subject.slice(opener.index + 1, startPos - 1));
      if (suffix) {
        link.align = suffix.align ?? '';
        link.width = suffix.width ?? 0;
        link.height = suffix.height ?? 0;
      }
    }
    let n = opener.node.next;
    while (n) {
      const next: Node | null = n.next;
      link.append(n);
      n = next;
    }
    block.append(link);
    this.processEmphasis(opener.prevDelimiter);
    this.brackets = opener.prev;
    opener.node.unlink();

    // Links may not contain other links: deactivate earlier link openers.
    if (!opener.image) {
      for (let b = this.brackets; b; b = b.prev) if (!b.image) b.active = false;
    }
    return true;
  }

  private spnl(): void {
    this.match(reSpnl);
  }

  /** Returns the decoded destination, or null if there is none here. Records where it was written in `destRange`. */
  parseLinkDestination(): string | null {
    const braces = this.pos;
    const m = this.match(reLinkDestinationBraces);
    if (m) {
      this.destRange = { from: braces + 1, to: this.pos - 1 };
      return unescapeString(m[0].slice(1, -1));
    }
    if (this.peek() === C_LESSTHAN) return null;

    const start = this.pos;
    let depth = 0;
    for (;;) {
      const c = this.peek();
      if (c === -1) break;
      if (c === C_BACKSLASH && reEscapable.test(this.subject[this.pos + 1] ?? '')) {
        this.pos += 2;
      } else if (c === C_OPEN_PAREN) {
        this.pos += 1;
        depth += 1;
        // The spec allows limiting the nesting; this keeps "[a](" repeated
        // many times from rescanning the rest of the paragraph each time.
        if (depth > 32) return null;
      } else if (c === C_CLOSE_PAREN) {
        if (depth < 1) break;
        this.pos += 1;
        depth -= 1;
      } else if (c <= 0x20 || c === 0x7f) {
        // Spaces and ASCII control characters end the destination.
        break;
      } else {
        this.pos += 1;
      }
    }
    if (this.pos === start && this.peek() !== C_CLOSE_PAREN) return null;
    if (depth !== 0) return null;
    this.destRange = { from: start, to: this.pos };
    return unescapeString(this.subject.slice(start, this.pos));
  }

  parseLinkTitle(): string | null {
    const start = this.pos;
    const quote = this.subject[start];
    // A title that found no closing quote from here cannot find one from a
    // later position either; remember that to stay linear.
    const failedFrom = quote === undefined ? undefined : this.titleFailedFrom.get(quote);
    if (failedFrom !== undefined && start >= failedFrom) return null;
    const m = this.match(reLinkTitle);
    if (!m) {
      // (A "(" title also fails at a nested "(", so only quotes are remembered.)
      if (quote === '"' || quote === "'") this.titleFailedFrom.set(quote, start);
      return null;
    }
    this.titleRange = { from: start, to: this.pos };
    return unescapeString(m[0].slice(1, -1));
  }

  /** Length of the link label at the current position (including brackets), or 0. */
  parseLinkLabel(): number {
    const start = this.pos;
    const m = this.match(reLinkLabel);
    if (!m || m[0].length > 1001) {
      this.pos = start;
      return 0;
    }
    return m[0].length;
  }

  /**
   * Parses one link reference definition at the start of `this.subject` and
   * stores it in the map (the first definition of a label wins). Returns the
   * number of characters consumed, or 0 if there is no definition.
   */
  parseReference(): number {
    const n = this.parseLinkLabel();
    if (n === 0) return 0;
    const rawLabel = this.subject.slice(0, n);
    if (this.peek() !== C_COLON) return 0;
    this.pos += 1;
    this.spnl();
    const dest = this.parseLinkDestination();
    if (dest === null) return 0;

    const beforeTitle = this.pos;
    this.spnl();
    let title: string | null = null;
    if (this.pos !== beforeTitle) title = this.parseLinkTitle();
    if (title === null) this.pos = beforeTitle;
    // The definition must end at the end of a line. If a title was found but
    // is followed by more text (an empty one too: `""x`), the definition may
    // still be valid without it.
    if (!this.match(reSpaceAtEndOfLine)) {
      if (title === null) return 0;
      title = null;
      this.pos = beforeTitle;
      if (!this.match(reSpaceAtEndOfLine)) return 0;
    }
    const label = normalizeLabel(rawLabel);
    if (label === '') return 0;
    if (!this.refs.has(label)) this.refs.set(label, { destination: dest, title: title ?? '' });
    return this.pos;
  }
}

/**
 * Parses link reference definitions at the start of a paragraph's raw
 * content into `refs`. Returns the rest of the content.
 */
export function extractReferences(content: string, refs: RefMap): string {
  while (content.charCodeAt(0) === C_OPEN_BRACKET) {
    const consumed = new InlineParser(content, refs, []).parseReference();
    if (consumed === 0) break;
    content = content.slice(consumed);
  }
  return content;
}

/** The code point ending just before `i`, as a string (handles surrogate pairs). */
function charBefore(s: string, i: number): string {
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1]!;
}

function charAt(s: string, i: number): string {
  return String.fromCodePoint(s.codePointAt(i)!);
}
