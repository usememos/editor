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

import { type Block, type Doc, htmlBlock, quoteKind, sameQuote } from '../model';
import { parseAst } from './blocks';
import { detailsSections, htmlSectionEnd } from './htmlSection';
import { lowerTopLevel } from './lower';
import { DEFAULT_MARKDOWN, type MarkdownOptions } from './options';
import { isEmptyParagraph, serializeBlocks } from './serialize';

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
}

export interface MarkdownSource {
  readonly text: string;
  readonly groups: readonly SourceGroup[];
  /** The group of each loaded block. An edited block is a new object and is not in the map. */
  readonly groupOf: WeakMap<Block, SourceGroup>;
  /** Source of every link reference definition, so a kept block's reference links keep working. */
  readonly definitions: readonly string[];
}

/** Parses Markdown and remembers its source, for `serializeMarkdown(doc, { source })`. */
export function loadMarkdown(text: string, options?: MarkdownOptions): { doc: Doc; source: MarkdownSource } {
  const root = parseAst(text, options);
  const lineStarts = [0];
  const lineEnds: number[] = [];
  const re = /\r\n|\n|\r/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    lineEnds.push(m.index);
    lineStarts.push(m.index + m[0].length);
  }
  lineEnds.push(text.length);

  const blocks: Block[] = [];
  const groups: SourceGroup[] = [];
  const groupOf = new WeakMap<Block, SourceGroup>();
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
    const lowered = section ? [section] : last > i ? [htmlBlock(source)] : lowerTopLevel(node, options ?? DEFAULT_MARKDOWN, source, blocks[blocks.length - 1]);
    i = last;
    blocks.push(...lowered);
    // Line ranges never overlap; if they ever did, the block is just not kept.
    if (lowered.length === 0 || from < lastEnd || to < from) continue;
    lastEnd = to;
    const open = (node.type === 'codeBlock' && node.fenced) || node.type === 'htmlBlock' ? isOpen(source, options) : false;
    const group: SourceGroup = { index: groups.length, from, to, blocks: lowered, open };
    groups.push(group);
    for (const block of lowered) groupOf.set(block, group);
  }
  return { doc: { blocks }, source: { text, groups, groupOf, definitions: root.definitions } };
}

/** True if a block's source would swallow a paragraph written after it. */
function isOpen(source: string, options: MarkdownOptions | undefined): boolean {
  return parseAst(source + '\n\nx', options).children.length < 2;
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
  // 1. Split the blocks into kept groups and runs of other blocks.
  const chunks: Chunk[] = [];
  for (let i = 0; i < blocks.length; ) {
    const block = blocks[i]!;
    const group = source.groupOf.get(block);
    if (group && group.blocks[0] === block && group.blocks.every((b, k) => blocks[i + k] === b)) {
      chunks.push({ group, blocks: [...group.blocks] });
      i += group.blocks.length;
      continue;
    }
    firstBlocks ??= new Map(source.groups.map((g) => [g.blocks[0]!.id, g]));
    const ticked = tickedGroup(blocks, i, firstBlocks, source, options);
    if (ticked) {
      chunks.push(ticked);
      i += ticked.blocks.length;
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
  const reread = loadMarkdown(patched, options).doc.blocks;
  if (serializeBlocks(reread, options) !== serializeBlocks(current, options)) return null;
  return { group: loaded, blocks: current, text: patched };
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
