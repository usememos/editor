// Source-preserving load and save.
//
// Loading remembers, for every top-level Markdown block, the exact source
// text it came from and the model blocks it became (its "group"). Blocks are
// immutable and every edit replaces the blocks it touches, so a group whose
// blocks are all still the same objects, in the same order, was not edited.
// Saving writes such a group's original text, and keeps the original text
// between two groups that are still neighbours. Everything else is written
// by the normalizing serializer. With no edits, saving returns the input
// byte for byte.

import { type Block, type Doc, type QuoteKind, htmlBlock, quoteKind, rawBlock, sameQuote, unquote } from '../model';
import type { BlockNode } from './ast';
import { parseAst } from './blocks';
import { detailsSections, htmlSectionEnd } from './htmlSection';
import { type SourceText, lowerIfFits, sourceText, stripQuoteMarker } from './lower';
import { type LineTable, type Segment, identitySegment } from './sourceMap';
import { DEFAULT_MARKDOWN, type MarkdownOptions } from './options';
import { interrupts, isEmptyParagraph, prefixLines, serializeBlocks } from './serialize';

export interface SourceGroup {
  /** Position among the groups of the source. */
  readonly index: number;
  /** Source range: from the start of the first line to the end of the last line, without its line ending. */
  readonly from: number;
  readonly to: number;
  /** The blocks the source lowered to, in order. */
  readonly blocks: readonly Block[];
  /**
   * The source may continue into whatever follows it (a code fence or HTML
   * block without its closing line). It is then kept only at the end.
   */
  readonly open: boolean;
  /** For a block quote: the source of each block it holds, so an edit to one keeps the others as written. */
  readonly quote?: QuoteSource;
}

/**
 * The parts of a quote's source: its kind, and the children of the
 * blockquote in order, each with its source lines (quote markers included,
 * trailing blank quote lines left out) and the blocks it became. The text
 * before the first child, a callout's marker line among it, and the text
 * after the last are the group's lead and tail.
 */
export interface QuoteSource {
  readonly kind: QuoteKind;
  readonly children: readonly QuoteChild[];
}

export interface QuoteChild {
  readonly from: number;
  readonly to: number;
  readonly blocks: readonly Block[];
}

export interface MarkdownSource {
  readonly text: string;
  readonly groups: readonly SourceGroup[];
  /** The group of each loaded block. An edited block is a new object and is not in the map. */
  readonly groupOf: WeakMap<Block, SourceGroup>;
  /** Source of every link reference definition, so a kept block's reference links keep working. */
  readonly definitions: readonly string[];
  /** Where each loaded block's text is in `text` (see `sourceMap.ts`). Tables and blocks with no text have none. */
  readonly mapOf: WeakMap<Block, readonly Segment[]>;
}

/**
 * Parses Markdown and remembers its source, for `serializeMarkdown(doc, { source })`.
 * `maps` false skips the source maps, for a caller that keeps only the document.
 */
export function loadMarkdown(text: string, options?: MarkdownOptions, maps = true): { doc: Doc; source: MarkdownSource } {
  const root = parseAst(text, options);
  const { lines: table } = sourceText(text);
  const { starts: lineStarts, ends: lineEnds } = table;
  /** The children of the quote being lowered, as `lowerQuote` reports them. */
  let quoteChildren: { node: BlockNode; blocks: readonly Block[] }[] = [];
  const src: SourceText = { text, lines: table, onQuoteChild: (node, lowered) => quoteChildren.push({ node, blocks: lowered }) };

  const blocks: Block[] = [];
  const groups: SourceGroup[] = [];
  const groupOf = new WeakMap<Block, SourceGroup>();
  const mapOf = new WeakMap<Block, readonly Segment[]>();
  const ctx = maps ? { lines: table, maps: mapOf } : undefined;
  let lastEnd = 0;
  const sections = (options ?? DEFAULT_MARKDOWN).details === false ? null : detailsSections(root.children);
  for (let i = 0; i < root.children.length; i++) {
    const node = root.children[i]!;
    // The tags of a collapsible section are blocks of their own; the Markdown between them is lowered as usual.
    const section = sections?.get(i);
    // Any other HTML element with Markdown between its tags is one raw HTML block (see htmlSection.ts).
    const last = section ? i : htmlSectionEnd(root.children, i);
    const from = lineStarts[root.lines[i]!.start - 1] ?? text.length;
    const lines = root.lines[last]!;
    const to = lineEnds[Math.max(lines.start, lines.end) - 1] ?? text.length;
    const source = text.slice(from, to);
    // A block holding the group's source as it is maps to it offset for offset.
    const verbatim = (block: Block) => {
      if (ctx) mapOf.set(block, [identitySegment(0, source.length, from)]);
      return block;
    };
    quoteChildren = [];
    const lowered = section
      ? [section]
      : last > i
        ? [verbatim(htmlBlock(source))]
        : (lowerIfFits(node, options ?? DEFAULT_MARKDOWN, blocks[blocks.length - 1], ctx, src) ?? [verbatim(rawBlock('markdown', source))]);
    i = last;
    blocks.push(...lowered);
    // Line ranges never overlap; if they ever did, the block is just not kept.
    if (lowered.length === 0 || from < lastEnd || to < from) continue;
    lastEnd = to;
    const open = (node.type === 'codeBlock' && node.fenced) || node.type === 'htmlBlock' ? isOpen(source, options) : false;
    const quote = node.type === 'blockQuote' && last === i ? quoteSource(quoteChildren, lowered, lines.end, text, table) : undefined;
    const group: SourceGroup = quote ? { index: groups.length, from, to, blocks: lowered, open, quote } : { index: groups.length, from, to, blocks: lowered, open };
    groups.push(group);
    for (const block of lowered) groupOf.set(block, group);
  }
  return { doc: { blocks }, source: { text, groups, groupOf, definitions: root.definitions, mapOf } };
}

/** True if a block's source would swallow a paragraph written after it. */
function isOpen(source: string, options: MarkdownOptions | undefined): boolean {
  return parseAst(source + '\n\nx', options).children.length < 2;
}

/** True for a blank line of a quote: nothing after its marker, or no marker and only whitespace. */
const isBlankQuoteLine = (line: string) => /^[ \t]*$/.test(stripQuoteMarker(line));

/**
 * The source of each child of a quote (see `QuoteSource`), from the
 * children `lowerQuote` reported and the blocks the quote became. A child
 * runs from its first line to the last line before the next child, or
 * before the end of the quote (`lastLine`), that is not a blank quote line.
 * A callout's marker line is left to the lead, and the marker-only paragraph
 * of a callout, which becomes no block, is no child. Undefined when a
 * child's lines are unknown, or the quote became no blocks.
 */
function quoteSource(
  reported: readonly { node: BlockNode; blocks: readonly Block[] }[],
  lowered: readonly Block[],
  lastLine: number,
  text: string,
  lines: LineTable,
): QuoteSource | undefined {
  const kind = quoteKind(lowered[0]);
  if (kind === null) return undefined;
  // The blocks as they are in the document: `lowerIfFits` may have replaced the first one to mark a quote start.
  const byId = new Map(lowered.map((b) => [b.id, b]));
  const children: { start: number; blocks: Block[] }[] = [];
  for (const [c, { node, blocks }] of reported.entries()) {
    if (blocks.length === 0) continue;
    const start = startLineOf(node);
    if (start === null) return undefined;
    // A callout's first paragraph starts with the marker line; its text starts on the next.
    children.push({ start: c === 0 && kind !== 'quote' ? start + 1 : start, blocks: blocks.map((b) => byId.get(b.id) ?? b) });
  }
  const lineText = (n: number) => text.slice(lines.starts[n - 1] ?? text.length, lines.ends[n - 1] ?? text.length);
  const out: QuoteChild[] = [];
  children.forEach(({ start, blocks }, c) => {
    const from = lines.starts[start - 1] ?? text.length;
    let end = children[c + 1] ? children[c + 1]!.start - 1 : lastLine;
    while (end > start && isBlankQuoteLine(lineText(end))) end--;
    const to = lines.ends[end - 1] ?? from;
    out.push({ from, to: Math.max(from, to), blocks });
  });
  return { kind, children: out };
}

/** The first source line of a block node the parser built, or null for one it did not. */
function startLineOf(node: BlockNode): number | null {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'htmlBlock':
    case 'raw':
      return node.source?.lines[0]?.line ?? null;
    default:
      return node.lines?.start ?? null;
  }
}

interface Chunk {
  group: SourceGroup | null;
  blocks: Block[];
  /** The group's source with ticked task boxes rewritten, when that is the only change. */
  text?: string;
}

/** Lists, and quotes with the same callout, next to each other in Markdown merge into one. */
function joins(a: Block | undefined, b: Block | undefined): boolean {
  if (quoteKind(a) !== null || quoteKind(b) !== null) return sameQuote(a, b);
  return a?.type === 'listItem' && b?.type === 'listItem';
}

export function saveWithSource(blocks: readonly Block[], source: MarkdownSource, options?: MarkdownOptions): string {
  const text = source.text;
  /** Groups by the ID of their first block, to find a group whose blocks were replaced. Built on first use. */
  let firstBlocks: Map<string, SourceGroup> | undefined;
  /** The quote group and child of every block loaded from a quote, by ID. Built on first use. */
  let quoteBlocks: QuoteIndex | undefined;
  // 1. Split the blocks into kept groups and runs of other blocks.
  const chunks: Chunk[] = [];
  for (let i = 0; i < blocks.length; ) {
    const block = blocks[i]!;
    const group = source.groupOf.get(block);
    if (group && group.blocks[0] === block && group.blocks.every((b, k) => blocks[i + k] === b)) {
      // A quote whose blocks are all kept but that goes on into a block added after them is written child by
      // child instead (below), so its own blocks stay as written where the serializer would rewrite the whole quote.
      const after = blocks[i + group.blocks.length];
      if (!(group.quote && after && sameQuote(group.blocks[group.blocks.length - 1], after))) {
        chunks.push({ group, blocks: [...group.blocks] });
        i += group.blocks.length;
        continue;
      }
    }
    firstBlocks ??= new Map(source.groups.map((g) => [g.blocks[0]!.id, g]));
    const ticked = tickedGroup(blocks, i, firstBlocks, source, options);
    if (ticked) {
      chunks.push(ticked);
      i += ticked.blocks.length;
      continue;
    }
    quoteBlocks ??= quoteIndex(source);
    const quoted = quoteChunk(blocks, i, quoteBlocks, source, options);
    if (quoted) {
      chunks.push(quoted);
      i += quoted.blocks.length;
      continue;
    }
    const last = chunks[chunks.length - 1];
    if (last && !last.group) last.blocks.push(block);
    else chunks.push({ group: null, blocks: [block] });
    i++;
  }

  // 2. A kept list or quote next to an edited one would merge with it in
  //    Markdown, and an open group would swallow what follows it. The same
  //    goes for two kept groups that were not neighbours in the source (the
  //    blocks between them were deleted), and a kept group that starts with
  //    indentation after a list would become part of its last item. Write
  //    those groups normally too.
  /** True if `chunk` comes right after `prev` and the text between them did not come from the source. */
  const newNeighbour = (prev: Chunk | undefined, chunk: Chunk) =>
    !!prev && (!prev.group || !chunk.group || chunk.group.index !== prev.group.index + 1);
  const indented = (chunk: Chunk) => !!chunk.group && /^[ \t]/.test(text.slice(chunk.group.from, chunk.group.to));
  for (let changed = true; changed; ) {
    changed = false;
    chunks.forEach((chunk, k) => {
      if (!chunk.group) return;
      const prev = chunks[k - 1];
      const next = chunks[k + 1];
      const first = chunk.blocks[0];
      const last = chunk.blocks[chunk.blocks.length - 1];
      const before = prev?.blocks[prev.blocks.length - 1];
      if (
        (newNeighbour(prev, chunk) && (joins(before, first) || (before?.type === 'listItem' && indented(chunk)))) ||
        (next && newNeighbour(chunk, next) && joins(last, next.blocks[0])) ||
        (chunk.group.open && next)
      ) {
        chunk.group = null;
        changed = true;
      }
    });
    for (let k = chunks.length - 1; k > 0; k--) {
      if (!chunks[k]!.group && !chunks[k - 1]!.group) {
        chunks[k - 1]!.blocks.push(...chunks[k]!.blocks);
        chunks.splice(k, 1);
      }
    }
  }

  // 3. Empty lines added at the end render as nothing, so they are not written.
  const tail = chunks[chunks.length - 1];
  if (tail && !tail.group) {
    while (tail.blocks.length > 0 && isEmptyParagraph(tail.blocks[tail.blocks.length - 1]!)) tail.blocks.pop();
    if (tail.blocks.length === 0) chunks.pop();
  }

  // 4. Write each chunk, with the original text between neighbouring groups.
  if (chunks.length === 0 && source.groups.length === 0) {
    // The source has nothing that becomes a block (for example only ">"), and nothing was added.
    return text;
  }
  const kept = new Set<number>();
  for (const chunk of chunks) if (chunk.group) kept.add(chunk.group.index);
  /** Source text between groups `a` and `b`, if it is safe to reuse: it must end a paragraph. */
  const gapBetween = (a: SourceGroup | undefined, b: SourceGroup | undefined): string | null => {
    if (!a || !b) return null;
    const gap = text.slice(a.to, b.from);
    return /(?:\r\n|\n|\r)[ \t]*(?:\r\n|\n|\r)/.test(gap) ? gap : null;
  };
  let out = '';
  let prev: Chunk | undefined;
  for (const chunk of chunks) {
    const body = chunk.group ? (chunk.text ?? text.slice(chunk.group.from, chunk.group.to)) : serializeBlocks(chunk.blocks, options);
    if (body === '' && !chunk.group) continue;
    const g = chunk.group;
    const p = prev?.group;
    if (!prev) {
      if (g?.index === 0) out += text.slice(0, g.from);
    } else if (p && g && g.index === p.index + 1) {
      out += text.slice(p.to, g.from);
    } else {
      // Next to an edited block, reuse the blank lines that surrounded the
      // group it replaced.
      let gap: string | null = null;
      if (p && !g && !kept.has(p.index + 1)) gap = gapBetween(p, source.groups[p.index + 1]);
      if (g && !p && !kept.has(g.index - 1)) gap = gapBetween(source.groups[g.index - 1], g);
      out += gap ?? '\n\n';
    }
    out += body;
    prev = chunk;
  }
  const last = prev?.group;

  const newline = text === '' || /[\r\n]$/.test(text) ? '\n' : '';
  let ending = last && last.index === source.groups.length - 1 ? text.slice(last.to) : out === '' ? '' : newline;

  // Reference definitions are global: keep any that are no longer written,
  // so the reference links in kept blocks still resolve.
  const written = squash(out + ending);
  const missing = source.definitions.filter((d) => !written.includes(squash(d)));
  if (missing.length > 0) {
    const body = out.replace(/[\r\n]+$/, '');
    out = (body ? body + '\n\n' : '') + missing.join('\n');
    ending = newline;
  }
  return out + ending;
}

/** A task list item marker: indentation and any quote markers, a bullet or number, spaces, then `[ ]`, `[x]` or `[X]`. */
const reTaskLine = /^((?:[ \t]*>)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[)([ xX])(?=\][ \t]|\]$)/gm;

/**
 * The group that starts at `blocks[i]` as a kept chunk, when the only
 * change to it is the `checked` state of task items: each block is the
 * loaded object or a task item that differs from it only in `checked`.
 * The chunk's text is the group's source with the box of each changed
 * item rewritten. The result is parsed again and used only if it reads
 * back as the current blocks; otherwise null, and the group is serialized.
 */
function tickedGroup(
  blocks: readonly Block[],
  i: number,
  firstBlocks: ReadonlyMap<string, SourceGroup>,
  source: MarkdownSource,
  options?: MarkdownOptions,
): Chunk | null {
  const loaded = firstBlocks.get(blocks[i]!.id);
  if (!loaded || loaded.open) return null;
  const current = blocks.slice(i, i + loaded.blocks.length);
  if (current.length !== loaded.blocks.length) return null;
  let changed = false;
  for (let k = 0; k < current.length; k++) {
    const a = loaded.blocks[k]!;
    const b = current[k]!;
    if (a === b) continue;
    if (!onlyChecked(a, b)) return null;
    changed = true;
  }
  if (!changed) return null;
  const tasks = current.filter((b) => b.type === 'listItem' && b.listType === 'task');
  const original = source.text.slice(loaded.from, loaded.to);
  let n = 0;
  const patched = original.replace(reTaskLine, (match, head: string, box: string) => {
    const block = tasks[n++];
    if (!block || block.type !== 'listItem') return match;
    const checked = box !== ' ';
    return checked === block.checked ? match : head + (block.checked ? 'x' : ' ');
  });
  if (n !== tasks.length) return null;
  const reread = loadMarkdown(patched, options, false).doc.blocks;
  if (serializeBlocks(reread, options) !== serializeBlocks(current, options)) return null;
  return { group: loaded, blocks: current, text: patched };
}

type QuoteIndex = ReadonlyMap<string, { group: SourceGroup; child: number }>;

function quoteIndex(source: MarkdownSource): QuoteIndex {
  const index = new Map<string, { group: SourceGroup; child: number }>();
  for (const group of source.groups) {
    group.quote?.children.forEach((child, c) => {
      for (const block of child.blocks) index.set(block.id, { group, child: c });
    });
  }
  return index;
}

/** A piece of a quote being written: the blocks of one child as loaded (`child` is its index), or a run of other blocks. */
interface QuotePiece {
  blocks: Block[];
  child: number | null;
}

/**
 * The blockquote that starts at `blocks[i]` as a chunk written child by
 * child, when some of its children are still the loaded blocks: those are
 * written as they were, with the original text between neighbouring ones,
 * and the other blocks through the serializer. Null when no child is kept,
 * when the blockquote holds blocks of more than one loaded quote, or when
 * its kind changed, which the serializer handles.
 */
function quoteChunk(blocks: readonly Block[], i: number, index: QuoteIndex, source: MarkdownSource, options?: MarkdownOptions): Chunk | null {
  const kind = quoteKind(blocks[i]);
  if (kind === null) return null;
  let end = i + 1;
  while (end < blocks.length && sameQuote(blocks[end - 1], blocks[end])) end++;
  const run = blocks.slice(i, end);
  const group = run.map((b) => index.get(b.id)?.group).find((g) => g !== undefined);
  const quote = group?.quote;
  if (!group || !quote || quote.kind !== kind) return null;
  const text = source.text;

  // 1. The run as pieces: each child whose blocks are all still there, in order, is one; the rest are runs between them.
  const pieces: QuotePiece[] = [];
  for (let p = 0; p < run.length; ) {
    const at = index.get(run[p]!.id);
    if (at && at.group !== group) return null;
    const child = at ? quote.children[at.child]! : null;
    if (child && child.blocks.every((b, k) => run[p + k] === b)) {
      pieces.push({ blocks: [...child.blocks], child: at!.child });
      p += child.blocks.length;
      continue;
    }
    const last = pieces[pieces.length - 1];
    if (last && last.child === null) last.blocks.push(run[p]!);
    else pieces.push({ blocks: [run[p]!], child: null });
    p++;
  }
  if (!pieces.some((piece) => piece.child !== null)) return null;

  // 2. A kept child next to a piece that was not its neighbour in the source is written through the serializer too
  //    when the two would read as one list, when it starts with indentation that a list before it would take, or
  //    when its source runs on into whatever follows (a fence without its closing line).
  const childText = (c: number) => text.slice(quote.children[c]!.from, quote.children[c]!.to);
  const neighbours = (a: QuotePiece, b: QuotePiece) => a.child !== null && b.child !== null && b.child === a.child + 1;
  const lists = (a: QuotePiece, b: QuotePiece) => a.blocks[a.blocks.length - 1]!.type === 'listItem' && b.blocks[0]!.type === 'listItem';
  /** True if the child's first line, after its marker, starts with whitespace. */
  const indented = (piece: QuotePiece) => piece.child !== null && /^[ \t]/.test(stripQuoteMarker(childText(piece.child).split(/\r\n|\n|\r/, 1)[0]!));
  /** True if the child's source runs on into a block written after it; parsed once per child. */
  const openChildren = new Map<number, boolean>();
  const swallows = (piece: QuotePiece) => {
    if (piece.child === null) return false;
    let open = openChildren.get(piece.child);
    if (open === undefined) {
      // A blank quote line ends a paragraph or a list; a fence or an HTML comment without its end runs through it.
      const parsed = parseAst(`${childText(piece.child)}\n>\n> x`, options).children[0];
      open = parsed?.type === 'blockQuote' && parsed.children.length < 2;
      openChildren.set(piece.child, open);
    }
    return open;
  };
  for (let changed = true; changed; ) {
    changed = false;
    pieces.forEach((piece, k) => {
      if (piece.child === null) return;
      const prev = pieces[k - 1];
      const next = pieces[k + 1];
      if (
        (prev && !neighbours(prev, piece) && (lists(prev, piece) || (prev.blocks[prev.blocks.length - 1]!.type === 'listItem' && indented(piece)))) ||
        (next && !neighbours(piece, next) && (lists(piece, next) || swallows(piece)))
      ) {
        piece.child = null;
        changed = true;
      }
    });
    for (let k = pieces.length - 1; k > 0; k--) {
      if (pieces[k]!.child === null && pieces[k - 1]!.child === null) {
        pieces[k - 1]!.blocks.push(...pieces[k]!.blocks);
        pieces.splice(k, 1);
      }
    }
  }
  if (!pieces.some((piece) => piece.child !== null)) return null;

  // 3. Write the pieces: a kept child as its source, the others serialized as they are inside the quote and marked.
  //    Neighbouring children keep the text between them; otherwise a blank quote line separates two pieces. The
  //    lead (blank lines, and a callout's marker line) is kept before the first child, and the tail after the last;
  //    a callout that no longer starts with its first child gets its marker line written.
  const lastChild = quote.children.length - 1;
  let out = '';
  pieces.forEach((piece, k) => {
    const prev = pieces[k - 1];
    if (!prev) {
      if (piece.child === 0) out += text.slice(group.from, quote.children[0]!.from);
      else if (kind !== 'quote') out += `> [!${kind.toUpperCase()}]\n${interrupts(piece.blocks[0]!) ? '' : '>\n'}`;
    } else if (neighbours(prev, piece)) {
      out += text.slice(quote.children[prev.child!]!.to, quote.children[piece.child!]!.from);
    } else {
      out += '\n>\n';
    }
    out += piece.child !== null ? childText(piece.child) : prefixLines(serializeBlocks(piece.blocks.map(unquote), options), '> ', '>');
  });
  const last = pieces[pieces.length - 1]!;
  if (last.child === lastChild) out += text.slice(quote.children[lastChild]!.to, group.to);
  return { group, blocks: run, text: out };
}

/** True if `b` is task item `a`, or a copy of it with only its `checked` state changed. */
function onlyChecked(a: Block, b: Block): boolean {
  return (
    a.type === 'listItem' &&
    b.type === 'listItem' &&
    a.listType === 'task' &&
    b.listType === 'task' &&
    a.id === b.id &&
    a.indent === b.indent &&
    a.content === b.content
  );
}

/** Text with whitespace runs collapsed, for finding a definition whatever its indentation. */
function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
