// HTML sections: an HTML element whose opening and closing tags are in
// different HTML blocks, with Markdown between them.
//
//   <details>
//   <summary>More</summary>
//
//   - Markdown inside
//
//   </details>
//
// CommonMark ends an HTML block at a blank line, so this is three blocks: the
// opening HTML, a list, and the closing HTML. Renderers that output HTML
// (GitHub, VS Code, markdown-it, remark) concatenate them, so the browser
// puts the list inside the element. The editor keeps such a section as one
// raw HTML block, so it stays together when blocks around it are edited, and
// renders it the same way: the HTML through the `html` view, and the
// Markdown between the tags as the editor's own blocks (see `splitHtmlSection`).

import { type Block, details, detailsEnd, plain } from '../model';
import { decodeEntities } from './inline';
import type { BlockNode } from './ast';
import { parseAst } from './blocks';
import { lowerTopLevel } from './lower';
import { DEFAULT_MARKDOWN, type MarkdownOptions } from './options';

/** Elements that have no closing tag. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

// Comments, and elements whose content is text rather than tags.
const reOpaque = /<!--[\s\S]*?-->|<(script|style|textarea|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const reTag = /<(\/?)([A-Za-z][A-Za-z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;

/**
 * Applies the tags of `html` to `open`, a stack of element names. A closing
 * tag closes the innermost element of its name and every element opened
 * inside it, as a browser does; a closing tag with no open element is ignored.
 */
function applyTags(html: string, open: string[]): void {
  const text = html.replace(reOpaque, '');
  reTag.lastIndex = 0;
  for (let m = reTag.exec(text); m; m = reTag.exec(text)) {
    const name = m[2]!.toLowerCase();
    if (!m[1]) {
      if (!m[3] && !VOID_ELEMENTS.has(name)) open.push(name);
      continue;
    }
    const at = open.lastIndexOf(name);
    if (at >= 0) open.length = at;
  }
}

/**
 * When top-level block `i` is an HTML block that leaves elements open, the
 * index of the HTML block that closes them all. Returns `i` when there is
 * nothing to join, including when the elements are never closed.
 */
export function htmlSectionEnd(nodes: readonly BlockNode[], i: number): number {
  const first = nodes[i]!;
  if (first.type !== 'htmlBlock') return i;
  const open: string[] = [];
  applyTags(first.value, open);
  if (open.length === 0) return i;
  for (let j = i + 1; j < nodes.length; j++) {
    const node = nodes[j]!;
    if (node.type !== 'htmlBlock') continue;
    applyTags(node.value, open);
    if (open.length === 0) return j;
  }
  return i;
}

const reDetailsOpen = /^<details(\s+open(?:\s*=\s*(?:""|''|"open"|'open'|open))?)?\s*>\s*<summary>([^<]*)<\/summary>\s*$/i;
const reDetailsClose = /^<\/details>\s*$/i;

/**
 * Collapsible sections among top-level blocks: an HTML block that is only
 * `<details>` (or `<details open>`) and a `<summary>` of plain text, and the
 * HTML block that is only `</details>` closing it, with Markdown between
 * them. Returns their indexes, each mapped to the block it becomes. Sections
 * nest. HTML between them that leaves an element open, which a renderer
 * would close at the section's end, keeps the sections around it as HTML.
 */
export function detailsSections(nodes: readonly BlockNode[]): Map<number, Block> {
  const out = new Map<number, Block>();
  const open: { index: number; block: Block }[] = [];
  nodes.forEach((node, i) => {
    if (node.type !== 'htmlBlock') return;
    const start = reDetailsOpen.exec(node.value);
    if (start) {
      open.push({ index: i, block: details(plain(decodeEntities(start[2]!.trim())), { open: !!start[1] }) });
    } else if (reDetailsClose.test(node.value)) {
      const section = open.pop();
      if (!section) return;
      out.set(section.index, section.block);
      out.set(i, detailsEnd());
    } else {
      const tags: string[] = [];
      applyTags(node.value, tags);
      if (tags.length > 0) open.length = 0;
    }
  });
  return out;
}

/** Marks where the blocks of slot `index` go in a section's HTML. Private-use characters, so they never meet real text. */
export const slotMarker = (index: number): string => `${index}`;

/** Finds slot markers in text. */
export const SLOT_MARKER = /(\d+)/g;

export interface HtmlSection {
  /**
   * The section's HTML, with each run of Markdown blocks replaced by
   * `slotMarker(index)` on a line of its own between blank lines.
   */
  readonly html: string;
  /** The Markdown between the tags, as blocks, one list per slot. */
  readonly slots: readonly (readonly Block[])[];
}

/**
 * Splits an HTML block's source into its HTML and the Markdown between its
 * tags, as CommonMark reads it. Null when the source holds no Markdown
 * blocks: it is all HTML.
 */
export function splitHtmlSection(source: string, options: MarkdownOptions = DEFAULT_MARKDOWN): HtmlSection | null {
  const root = parseAst(source, options);
  if (root.children.every((node) => node.type === 'htmlBlock')) return null;
  const lineStarts = [0];
  const lineEnds: number[] = [];
  const re = /\r\n|\n|\r/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    lineEnds.push(m.index);
    lineStarts.push(m.index + m[0].length);
  }
  lineEnds.push(source.length);
  // The source lines of top-level node `i`, as in loadMarkdown.
  const textOf = (i: number): string => {
    const lines = root.lines[i]!;
    const from = lineStarts[lines.start - 1] ?? source.length;
    const to = lineEnds[Math.max(lines.start, lines.end) - 1] ?? source.length;
    return source.slice(from, Math.max(from, to));
  };
  const parts: string[] = [];
  const slots: Block[][] = [];
  let slot: Block[] | null = null;
  root.children.forEach((node, i) => {
    if (node.type === 'htmlBlock') {
      slot = null;
      parts.push(textOf(i));
      return;
    }
    if (!slot) {
      slot = [];
      slots.push(slot);
      parts.push(`\n${slotMarker(slots.length - 1)}\n`);
    }
    slot.push(...lowerTopLevel(node, options, textOf(i), slot[slot.length - 1]));
  });
  return { html: parts.join('\n'), slots };
}
