// Markup ranges: where the Markdown syntax is in a text, and what it marks.
//
// Source mode dims markers and styles the text they mark. The ranges come
// from the parser's own records (the nodes' `pos` and `syntax`, the leaves'
// `ContentSource`, the blocks' `lines`), so what is marked is exactly what
// the editor reads as syntax: a literal `*` is not dimmed, and a `#` in a
// fence is code. Nothing scans the text a second way.

import type { BlockNode, ContentSource, InlineNode, ListItemNode, Range } from './ast';
import { parseAst } from './blocks';
import { firstWord } from './lower';
import type { MarkdownOptions } from './options';
import { SegmentBuilder, lineTable, sourcePieces } from './sourceMap';

/**
 * What a range of the text is: `marker` is syntax (delimiters, brackets,
 * list and quote markers, `#`, fences, pipes, a hard break's backslash);
 * the others are the text the markup marks, and `lang` a fence's info
 * string, `escape` an escape or entity, `url` a destination or bare URL,
 * `html` raw HTML and `token` an extension's syntax.
 */
export type MarkupKind = 'marker' | 'heading' | 'em' | 'strong' | 'strike' | 'code' | 'link' | 'url' | 'html' | 'token' | 'escape' | 'lang';

export interface MarkupRange extends Range {
  readonly kind: MarkupKind;
}

/** The content of a fenced or indented code block, for a code highlighter. */
export interface CodeRange extends Range {
  readonly language: string;
}

export interface Markup {
  /** In order of `from`; ranges of different kinds may nest (emphasis in a link). */
  readonly ranges: readonly MarkupRange[];
  readonly code: readonly CodeRange[];
}

const reQuoteMarker = /^(?:[ \t]*>[ \t]?)*/;
const reListMarker = /[ \t]*(?:[-*+]|\d{1,9}[.)])(?=[ \t\n\r]|$)/y;
const reFence = /^(`{3,}|~{3,})/;
const reTaskMarker = /^\[[ \t\nxX]\](?=[ \t\n]|$)/;

/** The Markdown syntax in `text`, as the parser reads it with `options`. */
export function markdownMarkup(text: string, options?: MarkdownOptions): Markup {
  const root = parseAst(text, options);
  const table = lineTable(text);
  const out: MarkupRange[] = [];
  const code: CodeRange[] = [];
  const push = (kind: MarkupKind, from: number, to: number) => {
    if (to > from) out.push({ from, to, kind });
  };
  const lineRange = (line: number): Range => ({ from: table.starts[line - 1] ?? text.length, to: table.ends[line - 1] ?? text.length });
  /** The content's `[from, to)` as `kind`, one range per source line it spans. */
  const pieces = (source: ContentSource, from: number, to: number, kind: MarkupKind) => {
    for (const r of sourcePieces(source, table, from, to)) push(kind, r.from, r.to);
  };

  /** The quote and list markers in a line's prefix, the part before its content. */
  const prefixMarkers = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const c = text[i];
      if (c === '>') push('marker', i, i + 1);
      else if (c === '-' || c === '*' || c === '+' || (c! >= '0' && c! <= '9')) {
        reListMarker.lastIndex = i;
        const m = reListMarker.exec(text);
        if (m && m.index === i) {
          push('marker', i + m[0].length - m[0].trimStart().length, i + m[0].length);
          i += m[0].length - 1;
        }
      }
    }
  };
  /** The markers of a line that holds no content of a leaf: an empty item, a fence, a thematic break or a table row. */
  const bareLineMarkers = (line: Range): number => {
    const quote = reQuoteMarker.exec(text.slice(line.from, line.to))![0];
    prefixMarkers(line.from, line.from + quote.length);
    reListMarker.lastIndex = line.from + quote.length;
    let at = line.from + quote.length;
    for (let m = reListMarker.exec(text); m && m.index === at; m = reListMarker.exec(text)) {
      push('marker', at + m[0].length - m[0].trimStart().length, at + m[0].length);
      at += m[0].length;
      reListMarker.lastIndex = at;
    }
    return at;
  };
  const contentLines = (source: ContentSource) => {
    for (const line of source.lines) {
      const start = table.starts[line.line - 1] ?? text.length;
      prefixMarkers(start, start + line.offset);
    }
  };
  /** A table row's pipes, and the escapes that keep a pipe in a cell (`\|`), read as `splitRow` in blocks.ts does. */
  const rowMarkers = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (text[i] === '\\' && i + 1 < to) {
        if (text[i + 1] === '|') push('escape', i, i + 2);
        i++;
      } else if (text[i] === '|') push('marker', i, i + 1);
    }
  };
  /** A leaf's content: its lines' prefixes, the text as `kind`, and the inline markup in it. */
  const inline = (source: ContentSource | undefined, nodes: readonly InlineNode[], kind?: MarkupKind) => {
    if (!source) return;
    contentLines(source);
    if (kind && nodes.length > 0) pieces(source, 0, Math.max(...nodes.map((n) => n.pos?.to ?? 0)), kind);
    inlineMarkup(source, nodes);
  };
  /** The markup of inline nodes parsed from `source`. */
  const inlineMarkup = (source: ContentSource, nodes: readonly InlineNode[]) => {
    const walk = (list: readonly InlineNode[]) => {
      for (const node of list) {
        const { pos } = node;
        if (!pos) continue;
        switch (node.type) {
          case 'text':
            if (node.pieces) {
              // The gaps between the verbatim pieces are escapes and entities.
              let at = pos.from;
              for (const p of node.pieces) {
                pieces(source, at, p.from, 'escape');
                at = p.to;
              }
              pieces(source, at, pos.to, 'escape');
            }
            break;
          case 'hardBreak': {
            const at = new SegmentBuilder(source, table).source(pos.from);
            if (text[at] === '\\') push('marker', at, at + 1);
            break;
          }
          case 'code': {
            for (const s of node.syntax ?? []) pieces(source, s.from, s.to, 'marker');
            if (node.content) pieces(source, node.content.from, node.content.to, 'code');
            break;
          }
          case 'html':
            pieces(source, pos.from, pos.to, 'html');
            break;
          case 'token':
            pieces(source, pos.from, pos.to, 'token');
            break;
          case 'emphasis':
          case 'strong':
          case 'strike': {
            const open = node.syntax?.find((s) => s.kind === 'open');
            const close = node.syntax?.find((s) => s.kind === 'close');
            for (const s of node.syntax ?? []) pieces(source, s.from, s.to, 'marker');
            pieces(source, open?.to ?? pos.from, close?.from ?? pos.to, node.type === 'emphasis' ? 'em' : node.type);
            walk(node.children);
            break;
          }
          case 'link':
          case 'image': {
            const open = node.syntax?.find((s) => s.kind === 'open');
            const close = node.syntax?.find((s) => s.kind === 'close');
            // The tail's markup is what is around the destination: `(`, a title, `)`.
            const dest = node.syntax?.find((s) => s.kind === 'dest');
            for (const s of node.syntax ?? []) {
              if (s.kind === 'dest') pieces(source, s.from, s.to, 'url');
              else if (s.kind === 'tail' && dest && dest.from >= s.from && dest.to <= s.to) {
                pieces(source, s.from, dest.from, 'marker');
                pieces(source, dest.to, s.to, 'marker');
              } else if (s.kind !== 'title') pieces(source, s.from, s.to, 'marker');
            }
            // The link's text, unless it is its own destination, as in an autolink.
            if (open && close && !(dest && dest.from === open.to && dest.to === close.from)) pieces(source, open.to, close.from, 'link');
            walk(node.children);
            break;
          }
          default:
            break;
        }
      }
    };
    walk(nodes);
  };
  /** The line a block starts on: its first content line, or a fence, break or table row; 0 for an empty item. */
  const firstLine = (node: BlockNode | ListItemNode): number => {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
      case 'htmlBlock':
      case 'raw':
        return node.source?.lines[0]?.line ?? 0;
      case 'codeBlock':
      case 'thematicBreak':
      case 'table':
        return node.lines?.start ?? 0;
      case 'blockQuote':
      case 'listItem':
        return node.children[0] ? firstLine(node.children[0]) : 0;
      case 'list':
        return node.items[0] ? firstLine(node.items[0]) : 0;
    }
  };
  const block = (node: BlockNode) => {
    switch (node.type) {
      case 'paragraph':
        inline(node.source, node.children);
        break;
      case 'heading': {
        inline(node.source, node.children, 'heading');
        const first = node.source?.lines[0];
        if (!first) break;
        if (node.setext) {
          const underline = lineRange(first.line + (node.source?.lines.length ?? 1));
          const quote = reQuoteMarker.exec(text.slice(underline.from, underline.to))![0];
          prefixMarkers(underline.from, underline.from + quote.length);
          push('marker', underline.from + quote.length, underline.to);
        } else {
          // The `#`s before the content, and an optional closing sequence after it.
          const line = lineRange(first.line);
          const prefix = text.slice(line.from, line.from + first.offset);
          const hashes = /#{1,6}[ \t]*$/.exec(prefix);
          if (hashes) push('marker', line.from + hashes.index, line.from + hashes.index + hashes[0].trimEnd().length);
          const rest = text.slice(line.from + first.offset, line.to);
          const closing = /(?:^|[ \t]+)(#+)[ \t]*$/.exec(rest);
          if (closing) push('marker', line.from + first.offset + closing.index + closing[0].indexOf('#'), line.from + first.offset + closing.index + closing[0].trimEnd().length);
        }
        break;
      }
      case 'thematicBreak':
        if (node.lines) {
          const line = lineRange(node.lines.start);
          push('marker', bareLineMarkers(line), line.to);
        }
        break;
      case 'blockQuote':
        node.children.forEach(block);
        break;
      case 'list':
        for (const item of node.items) {
          if (item.lines && firstLine(item) !== item.lines.start) bareLineMarkers(lineRange(item.lines.start));
          if (item.task) {
            // The box is the first thing in the item's first content line.
            const first = item.children[0];
            const source = first?.type === 'paragraph' ? first.source : undefined;
            const line = source?.lines[0];
            if (line) {
              const at = (table.starts[line.line - 1] ?? 0) + line.offset;
              if (reTaskMarker.test(text.slice(at, table.ends[line.line - 1]))) push('marker', at, at + 3);
            }
          }
          item.children.forEach(block);
        }
        break;
      case 'codeBlock': {
        if (!node.source || !node.lines) break;
        const content = node.source.lines;
        if (node.fenced) {
          const open = lineRange(node.lines.start);
          const at = bareLineMarkers(open);
          const rest = text.slice(at, open.to);
          const fence = rest.trimStart();
          const fenceAt = at + rest.length - fence.length;
          const m = reFence.exec(fence);
          if (m) {
            push('marker', fenceAt, fenceAt + m[1]!.length);
            push('lang', fenceAt + m[1]!.length, open.to);
          }
          const last = content[content.length - 1]?.line ?? node.lines.start;
          if (node.lines.end > last) {
            const close = lineRange(node.lines.end);
            push('marker', bareLineMarkers(close), close.to);
          }
        }
        contentLines(node.source);
        if (content.length > 0) {
          const length = node.value.replace(/\n$/, '').length;
          pieces(node.source, 0, length, 'code');
          const b = new SegmentBuilder(node.source, table);
          code.push({ from: b.source(0), to: b.source(length), language: firstWord(node.info) });
        }
        break;
      }
      case 'htmlBlock':
      case 'raw':
        if (node.source) {
          contentLines(node.source);
          pieces(node.source, 0, node.value.length, node.type === 'raw' ? 'token' : 'html');
        }
        break;
      case 'table':
        if (node.lines) {
          for (let n = node.lines.start; n <= node.lines.end; n++) {
            const line = lineRange(n);
            const at = bareLineMarkers(line);
            if (n === node.lines.start + 1) push('marker', at, line.to);
            else rowMarkers(at, line.to);
          }
          // Each cell's syntax, in the pieces of its row the cell was written in.
          node.sources?.forEach((row, r) => row.forEach((source, c) => inlineMarkup(source, node.rows[r]?.[c] ?? [])));
        }
        break;
    }
  };
  root.children.forEach(block);
  out.sort((a, b) => a.from - b.from || b.to - a.to);
  return { ranges: out, code };
}
