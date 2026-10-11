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

import type { Block, Doc } from '../model';
import { parseAst } from './blocks';
import { lowerTopLevel } from './lower';
import type { MarkdownOptions } from './options';
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
  root.children.forEach((node, i) => {
    const lines = root.lines?.[i];
    const from = lines ? (lineStarts[lines.start - 1] ?? text.length) : -1;
    const to = lines ? (lineEnds[Math.max(lines.start, lines.end) - 1] ?? text.length) : -1;
    // Line ranges never overlap; if they ever did, the block is just not kept.
    const valid = lines !== undefined && from >= lastEnd && to >= from;
    const source = valid ? text.slice(from, to) : undefined;
    const lowered = lowerTopLevel(node, options, source);
    blocks.push(...lowered);
    if (lowered.length === 0 || source === undefined) return;
    lastEnd = to;
    const open = (node.type === 'codeBlock' && node.fenced) || node.type === 'htmlBlock' ? isOpen(source, options) : false;
    const group: SourceGroup = { index: groups.length, from, to, blocks: lowered, open };
    groups.push(group);
    for (const block of lowered) groupOf.set(block, group);
  });
  return { doc: { blocks }, source: { text, groups, groupOf, definitions: root.definitions ?? [] } };
}

/** True if a block's source would swallow a paragraph written after it. */
function isOpen(source: string, options: MarkdownOptions | undefined): boolean {
  return parseAst(source + '\n\nx', options).children.length < 2;
}

interface Chunk {
  group: SourceGroup | null;
  blocks: Block[];
}

/** Lists and quotes next to each other in Markdown merge into one. */
function joins(a: Block | undefined, b: Block | undefined): boolean {
  return !!a && !!b && a.type === b.type && (a.type === 'listItem' || a.type === 'quote');
}

export function saveWithSource(blocks: readonly Block[], source: MarkdownSource, options?: MarkdownOptions): string {
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
    const last = chunks[chunks.length - 1];
    if (last && !last.group) last.blocks.push(block);
    else chunks.push({ group: null, blocks: [block] });
    i++;
  }

  // 2. A kept list or quote next to an edited one would merge with it in
  //    Markdown, and an open group would swallow what follows it. Write those
  //    groups normally too.
  for (let changed = true; changed; ) {
    changed = false;
    chunks.forEach((chunk, k) => {
      if (!chunk.group) return;
      const prev = chunks[k - 1];
      const next = chunks[k + 1];
      const first = chunk.blocks[0];
      const last = chunk.blocks[chunk.blocks.length - 1];
      if (
        (prev && !prev.group && joins(prev.blocks[prev.blocks.length - 1], first)) ||
        (next && !next.group && joins(last, next.blocks[0])) ||
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
  const text = source.text;
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
    const body = chunk.group ? text.slice(chunk.group.from, chunk.group.to) : serializeBlocks(chunk.blocks, options);
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

/** Text with whitespace runs collapsed, for finding a definition whatever its indentation. */
function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
