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
import type { InlineNode } from './ast';
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
  const nodes = new InlineParser(src, refs, syntax, autolinks).parse();
  return autolinks ? linkEmails(nodes) : nodes;
}

/**
 * E-mail autolink literals, found in the final text nodes outside links (as
 * cmark-gfm does), so a local part may hold "_" that the parser saw as a
 * possible delimiter.
 */
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
        if (from > pos) out.push({ type: 'text', value: node.value.slice(pos, from) });
        const email = node.value.slice(from, to);
        out.push({ type: 'link', destination: 'mailto:' + email, title: '', children: [{ type: 'text', value: email }] });
        pos = to;
      }
      if (pos < node.value.length) out.push({ type: 'text', value: node.value.slice(pos) });
    } else if (node.type === 'emphasis' || node.type === 'strong' || node.type === 'strike') {
      const children = linkEmails(node.children);
      if (children !== node.children) changed = true;
      out.push(children === node.children ? node : { type: node.type, children });
    } else {
      out.push(node);
    }
  }
  return changed ? out : nodes;
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
  parent: Node | null = null;
  first: Node | null = null;
  last: Node | null = null;
  prev: Node | null = null;
  next: Node | null = null;

  constructor(
    public type: NodeType,
    value = '',
  ) {
    this.value = value;
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
  for (let n = from.next; n && n !== to; n = n.next) if (n.depth >= depth) depth = n.depth + 1;
  return depth;
}

/** Converts the mutable tree to plain AST nodes, merging adjacent text nodes. */
function toAst(parent: Node): InlineNode[] {
  const out: InlineNode[] = [];
  for (let n = parent.first; n; n = n.next) {
    switch (n.type) {
      case 'text': {
        if (n.value === '') break;
        const prev = out[out.length - 1];
        if (prev?.type === 'text') out[out.length - 1] = { type: 'text', value: prev.value + n.value };
        else out.push({ type: 'text', value: n.value });
        break;
      }
      case 'softBreak':
      case 'hardBreak':
        out.push({ type: n.type });
        break;
      case 'code':
      case 'html':
        out.push({ type: n.type, value: n.value });
        break;
      case 'token':
        out.push({ type: 'token', name: n.name, value: n.value });
        break;
      case 'emphasis':
      case 'strong':
      case 'strike':
        out.push({ type: n.type, children: toAst(n) });
        break;
      case 'link':
      case 'image':
        out.push({ type: n.type, destination: n.destination, title: n.title, children: toAst(n) });
        break;
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
      block.append(new Node('text', String.fromCharCode(c)));
    }
  }

  /** An inline syntax extension's token at the current position. */
  private parseToken(c: number, block: Node): boolean {
    const syntaxes = this.triggers.get(c);
    if (!syntaxes) return false;
    for (const s of syntaxes) {
      const end = s.match(this.subject, this.pos);
      if (end > this.pos) {
        const node = new Node('token', this.subject.slice(this.pos, end));
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
        if (!isLiteralBoundary(this.subject[at - 1])) continue;
        const url = urlLiteralAt(this.subject, at);
        if (!url) continue;
        if (at > start) block.append(new Node('text', this.subject.slice(start, at)));
        const link = new Node('link');
        link.destination = url.href;
        link.append(new Node('text', this.subject.slice(at, url.end)));
        block.append(link);
        this.pos = url.end;
        return true;
      }
    }
    block.append(new Node('text', m[0]));
    return true;
  }

  /** A line ending: a hard break after two or more spaces, otherwise a soft break. */
  private parseNewline(block: Node): boolean {
    this.pos += 1;
    const last = block.last;
    let hard = false;
    if (last && last.type === 'text' && last.value.endsWith(' ')) {
      hard = last.value.endsWith('  ');
      last.value = last.value.replace(/ +$/, '');
    }
    block.append(new Node(hard ? 'hardBreak' : 'softBreak'));
    this.skipLineStart();
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
    this.pos += 1;
    const c = this.peek();
    if (c === C_NEWLINE) {
      this.pos += 1;
      block.append(new Node('hardBreak'));
      this.skipLineStart();
    } else if (c !== -1 && reEscapable.test(this.subject[this.pos]!)) {
      block.append(new Node('text', this.subject[this.pos]!));
      this.pos += 1;
    } else {
      block.append(new Node('text', '\\'));
    }
    return true;
  }

  private parseBackticks(block: Node): boolean {
    const ticks = this.match(reBackticks)![0];
    const n = ticks.length;
    const afterOpen = this.pos;
    const noneAfter = this.backticksAfter.get(n);
    if (noneAfter === undefined || afterOpen < noneAfter) {
      let m: RegExpExecArray | null;
      while ((m = this.match(reBackticks)) || this.findNextBacktick()) {
        if (!m) continue;
        if (m[0].length === n) {
          let code = this.subject.slice(afterOpen, this.pos - n).replace(/\n/g, ' ');
          if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) {
            code = code.slice(1, -1);
          }
          block.append(new Node('code', code));
          return true;
        }
      }
      this.backticksAfter.set(n, afterOpen);
    }
    // No matching closer: the run is literal text.
    this.pos = afterOpen;
    block.append(new Node('text', ticks));
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
    let m = this.match(reEmailAutolink);
    if (m) {
      const link = new Node('link');
      link.destination = 'mailto:' + m[1]!;
      link.append(new Node('text', m[1]!));
      block.append(link);
      return true;
    }
    m = this.match(reAutolink);
    if (m) {
      const link = new Node('link');
      link.destination = m[1]!;
      link.append(new Node('text', m[1]!));
      block.append(link);
      return true;
    }
    return false;
  }

  private parseHtmlTag(block: Node): boolean {
    const m = this.match(reHtmlTag);
    if (!m) return false;
    block.append(new Node('html', m[0]));
    return true;
  }

  private parseEntity(block: Node): boolean {
    const start = this.pos;
    const m = this.match(reEntityHere);
    if (m) {
      const decoded = decodeEntity(m[0]);
      if (decoded !== null) {
        block.append(new Node('text', decoded));
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

    let canOpen: boolean;
    let canClose: boolean;
    if (cc === C_UNDERSCORE) {
      canOpen = leftFlanking && (!rightFlanking || beforePunct);
      canClose = rightFlanking && (!leftFlanking || afterPunct);
    } else {
      canOpen = leftFlanking;
      canClose = rightFlanking;
    }
    // GFM strikethrough uses runs of one or two tildes only.
    if (cc === C_TILDE && count > 2) canOpen = canClose = false;

    const node = new Node('text', this.subject.slice(start, this.pos));
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
        if (!literal) {
          openerNode.value = openerNode.value.slice(0, openerNode.value.length - use);
          closerNode.value = closerNode.value.slice(0, closerNode.value.length - use);
          const wrapper = new Node(type);
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
    const node = new Node('text', '[');
    block.append(node);
    this.pushBracket(node, start, false);
    return true;
  }

  private parseBang(block: Node): boolean {
    const start = this.pos;
    this.pos += 1;
    if (this.peek() === C_OPEN_BRACKET) {
      this.pos += 1;
      const node = new Node('text', '![');
      block.append(node);
      this.pushBracket(node, start + 1, true);
    } else {
      block.append(new Node('text', '!'));
    }
    return true;
  }

  private parseCloseBracket(block: Node): boolean {
    this.pos += 1;
    const startPos = this.pos;
    const opener = this.brackets;
    if (!opener) {
      block.append(new Node('text', ']'));
      return true;
    }
    if (!opener.active) {
      block.append(new Node('text', ']'));
      this.brackets = opener.prev;
      return true;
    }

    let dest: string | null = null;
    let title: string | null = null;
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
      block.append(new Node('text', ']'));
      return true;
    }

    const link = new Node(opener.image ? 'image' : 'link');
    link.destination = dest ?? '';
    link.title = title ?? '';
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

  /** Returns the decoded destination, or null if there is none here. */
  parseLinkDestination(): string | null {
    const m = this.match(reLinkDestinationBraces);
    if (m) return unescapeString(m[0].slice(1, -1));
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
    if (title === null) {
      title = '';
      this.pos = beforeTitle;
    }
    // The definition must end at the end of a line. If a title was found but
    // is followed by more text, the definition may still be valid without it.
    if (!this.match(reSpaceAtEndOfLine)) {
      if (title === '') return 0;
      title = '';
      this.pos = beforeTitle;
      if (!this.match(reSpaceAtEndOfLine)) return 0;
    }
    const label = normalizeLabel(rawLabel);
    if (label === '') return 0;
    if (!this.refs.has(label)) this.refs.set(label, { destination: dest, title });
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
