// Rendered views (Extension.views) show their source where the user is
// editing: a token that either end of the selection touches, edges
// included, and a raw block that holds either end.

import type { SyntaxView } from '../extension';
import { type EditorState, type Position, type RawBlock, containerContent, getBlock, inlineText, tokensAt } from '../model';
import { type BlockReveal, REVEAL_BLOCK, sameReveal, tokenKey } from './dom';

/** Per block, the views that show their source. Empty when `active` is false (read-only or unfocused). */
export function revealedViews(
  state: EditorState,
  views: ReadonlyMap<string, SyntaxView>,
  active: boolean,
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
    if (block.type === 'raw') {
      if (views.has(block.syntax)) keys.add(REVEAL_BLOCK);
    } else {
      for (const { token, from } of tokensAt(containerContent(block, pos.cell) ?? [], pos.offset)) {
        if (views.has(token)) keys.add(tokenKey(pos.cell, from));
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
 * Where the caret goes in a rendered raw block's source: past its opening
 * line going forward (such as a `$$` fence), at the end of its next-to-last
 * line going back or on a click.
 */
export function viewEntry(block: RawBlock, forward: boolean): Position {
  const text = inlineText(block.content);
  if (forward) {
    const firstBreak = text.indexOf('\n');
    return { blockId: block.id, offset: firstBreak >= 0 && firstBreak < text.length - 1 ? firstBreak + 1 : 0 };
  }
  const lastBreak = text.lastIndexOf('\n');
  return { blockId: block.id, offset: lastBreak > 0 ? lastBreak : text.length };
}
