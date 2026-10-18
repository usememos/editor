// Rendered views (Extension.views) show their source where the user is
// editing: a token that either end of the selection touches, edges
// included, and a raw block that holds either end.

import type { SyntaxView } from '../extension';
import { type Block, type EditorState, type Position, containerContent, endOf, getBlock, inlineLength, inlineText, startOf, tokensAt } from '../model';
import { type BlockReveal, REVEAL_BLOCK, codeViewName, htmlRuns, sameReveal, tokenKey } from './dom';

/**
 * Per block, the views that show their source. Empty when `active` is false
 * (read-only or unfocused). `hosted` says whether an extension's block view
 * draws a block, which then shows its editable form instead.
 */
export function revealedViews(
  state: EditorState,
  views: ReadonlyMap<string, SyntaxView>,
  active: boolean,
  hosted?: (block: Block) => boolean,
): Map<string, BlockReveal> {
  const out = new Map<string, Set<string>>();
  if (!active) return out;
  const { anchor, focus } = state.selection;
  const focusBlock = getBlock(state.doc, focus.blockId);
  const anchorBlock = anchor.blockId === focus.blockId ? focusBlock : getBlock(state.doc, anchor.blockId);
  for (const [pos, block] of [
    [focus, focusBlock],
    [anchor, anchorBlock],
  ] as const) {
    const keys = out.get(block.id) ?? new Set<string>();
    if (hosted?.(block)) keys.add(REVEAL_BLOCK);
    if (block.type === 'raw') {
      if (views.has(block.syntax)) keys.add(REVEAL_BLOCK);
    } else if (block.type === 'code') {
      if (views.has(codeViewName(block.language))) keys.add(REVEAL_BLOCK);
    } else {
      const content = containerContent(block, pos.cell) ?? [];
      for (const { token, from } of tokensAt(content, pos.offset)) {
        if (views.has(token)) keys.add(tokenKey(pos.cell, from));
      }
      // A run of inline raw HTML shown by the `html` view, edges included.
      if (views.has('html') && content.some((s) => s.marks.includes('html'))) {
        for (const run of htmlRuns(content)) if (run.from <= pos.offset && pos.offset <= run.to) keys.add(tokenKey(pos.cell, run.from));
      }
    }
    if (keys.size > 0) out.set(block.id, keys);
  }
  return out;
}

export function sameRevealed(a: ReadonlyMap<string, BlockReveal>, b: ReadonlyMap<string, BlockReveal>): boolean {
  return a.size === b.size && [...a].every(([id, keys]) => sameReveal(keys, b.get(id)));
}

/**
 * Where the caret goes in a rendered block's source. A raw block: past its
 * opening line going forward (such as a `$$` fence), at the end of its
 * next-to-last line going back or on a click. A code block holds only the
 * code, and raw Markdown has no fence: their start or their end. So does any
 * other block drawn by a block view; a table, its first or last cell.
 */
export function viewEntry(block: Block, forward: boolean): Position {
  if (block.type === 'table') {
    const row = forward ? 0 : block.rows.length - 1;
    return { blockId: block.id, offset: forward ? 0 : inlineLength(block.rows[row]![0]!), cell: { row, col: 0 } };
  }
  if (block.type !== 'raw' && block.type !== 'code') return forward ? startOf(block) : endOf(block);
  const text = inlineText(block.content);
  if (block.type === 'code' || block.syntax === 'markdown') return { blockId: block.id, offset: forward ? 0 : text.length };
  if (forward) {
    const firstBreak = text.indexOf('\n');
    return { blockId: block.id, offset: firstBreak >= 0 && firstBreak < text.length - 1 ? firstBreak + 1 : 0 };
  }
  const lastBreak = text.lastIndexOf('\n');
  return { blockId: block.id, offset: lastBreak > 0 ? lastBreak : text.length };
}
