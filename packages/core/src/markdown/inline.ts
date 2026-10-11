// Inline Markdown parser: CommonMark emphasis (the delimiter-run algorithm
// from the spec, section 6.2 and appendix A), code spans, backslash escapes,
// and GFM strikethrough. Links, images, autolinks, raw HTML and entities are
// added in step 3; until then they stay literal text.

import { type Inline, type Mark, type Span, normalizeInline, sortMarks } from '../model';

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'mark'; mark: Mark; children: Node[] };

interface Delimiter {
  node: { kind: 'text'; text: string };
  char: '*' | '_' | '~';
  count: number;
  origCount: number;
  canOpen: boolean;
  canClose: boolean;
  prev: Delimiter | null;
  next: Delimiter | null;
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const UNICODE_WS = /\s/u;
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;

function isWs(ch: string | undefined): boolean {
  return ch === undefined || UNICODE_WS.test(ch);
}
function isPunct(ch: string | undefined): boolean {
  return ch !== undefined && UNICODE_PUNCT.test(ch);
}

export function parseInline(src: string): Inline {
  const nodes: Node[] = [];
  let head: Delimiter | null = null;
  let tail: Delimiter | null = null;
  let buf = '';
  const flush = () => {
    if (buf) nodes.push({ kind: 'text', text: buf });
    buf = '';
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    if (ch === '\\' && i + 1 < src.length && ASCII_PUNCT.test(src[i + 1]!)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      let n = 0;
      while (src[i + n] === '`') n++;
      const close = findBacktickRun(src, i + n, n);
      if (close < 0) {
        buf += '`'.repeat(n);
        i += n;
        continue;
      }
      let code = src.slice(i + n, close).replace(/\n/g, ' ');
      if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
        code = code.slice(1, -1);
      }
      flush();
      nodes.push({ kind: 'code', text: code });
      i = close + n;
      continue;
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      let n = 0;
      while (src[i + n] === ch) n++;
      const before = src[i - 1];
      const after = src[i + n];
      const left = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
      const right = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
      let canOpen: boolean;
      let canClose: boolean;
      if (ch === '_') {
        canOpen = left && (!right || isPunct(before));
        canClose = right && (!left || isPunct(after));
      } else {
        canOpen = left;
        canClose = right;
      }
      if (ch === '~' && n > 2) canOpen = canClose = false;

      flush();
      const node = { kind: 'text' as const, text: ch.repeat(n) };
      nodes.push(node);
      if (canOpen || canClose) {
        const d: Delimiter = { node, char: ch, count: n, origCount: n, canOpen, canClose, prev: tail, next: null };
        if (tail) tail.next = d;
        else head = d;
        tail = d;
      }
      i += n;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();

  processEmphasis(nodes, head, (d) => {
    if (d.prev) d.prev.next = d.next;
    else head = d.next;
    if (d.next) d.next.prev = d.prev;
    else tail = d.prev;
  });

  const spans: Span[] = [];
  flatten(nodes, [], spans);
  return normalizeInline(spans);
}

function findBacktickRun(src: string, from: number, n: number): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === '`') {
      let m = 0;
      while (src[i + m] === '`') m++;
      if (m === n) return i;
      i += m;
    } else {
      i++;
    }
  }
  return -1;
}

function processEmphasis(nodes: Node[], head: Delimiter | null, remove: (d: Delimiter) => void): void {
  const openersBottom = new Map<string, Delimiter | null>();
  let closer = head;

  while (closer) {
    if (!closer.canClose) {
      closer = closer.next;
      continue;
    }
    const key = `${closer.char}${closer.canOpen ? 1 : 0}${closer.origCount % 3}`;
    const bottom = openersBottom.has(key) ? openersBottom.get(key)! : null;

    let opener = closer.prev;
    let found: Delimiter | null = null;
    while (opener && opener !== bottom) {
      if (opener.char === closer.char && opener.canOpen) {
        if (closer.char === '~') {
          if (opener.count === closer.count) {
            found = opener;
            break;
          }
        } else {
          const oddMatch =
            (opener.canClose || closer.canOpen) &&
            (opener.origCount + closer.origCount) % 3 === 0 &&
            !(opener.origCount % 3 === 0 && closer.origCount % 3 === 0);
          if (!oddMatch) {
            found = opener;
            break;
          }
        }
      }
      opener = opener.prev;
    }

    if (!found) {
      openersBottom.set(key, closer.prev);
      const next = closer.next;
      if (!closer.canOpen) remove(closer);
      closer = next;
      continue;
    }

    const use = closer.char === '~' ? closer.count : closer.count >= 2 && found.count >= 2 ? 2 : 1;
    const mark: Mark = closer.char === '~' ? 'strike' : use === 2 ? 'bold' : 'italic';
    found.count -= use;
    closer.count -= use;
    found.node.text = found.node.text.slice(0, found.count);
    closer.node.text = closer.node.text.slice(use);

    const start = nodes.indexOf(found.node);
    const end = nodes.indexOf(closer.node);
    const children = nodes.splice(start + 1, end - start - 1);
    nodes.splice(start + 1, 0, { kind: 'mark', mark, children });

    for (let d = found.next; d && d !== closer; d = d.next) remove(d);

    if (found.count === 0) {
      nodes.splice(nodes.indexOf(found.node), 1);
      remove(found);
    }
    if (closer.count === 0) {
      nodes.splice(nodes.indexOf(closer.node), 1);
      const next = closer.next;
      remove(closer);
      closer = next;
    }
  }
}

function flatten(nodes: Node[], marks: Mark[], out: Span[]): void {
  for (const node of nodes) {
    if (node.kind === 'text') out.push({ text: node.text, marks: sortMarks(marks) });
    else if (node.kind === 'code') out.push({ text: node.text, marks: sortMarks([...marks, 'code']) });
    else flatten(node.children, [...marks, node.mark], out);
  }
}
