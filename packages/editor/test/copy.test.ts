// What a text selection copies: the selected part of one block as a
// paragraph, or the blocks it crosses, cut at its ends.

import { describe, expect, it } from 'vitest';
import * as cmd from '../src/commands';
import { parseMarkdown, serializeMarkdown } from '../src/index';
import { codeBlock, createState, heading, inlineText, isTextBlock, listItem, plain, type EditorState } from '../src/model';

const code = codeBlock('sh', 'tar cvpf a.tar ~/x\n# second *line*');
const head = heading(2, plain('Big title'));
const item = listItem('bullet', plain('an item'));
const state = createState({ blocks: [code, head, item] });
const select = (from: [string, number], to: [string, number]): EditorState => ({
  ...state,
  selection: { anchor: { blockId: from[0], offset: from[1] }, focus: { blockId: to[0], offset: to[1] } },
});
const copied = (s: EditorState) => serializeMarkdown({ blocks: cmd.closeSections(cmd.selectedBlocks(s)) }).replace(/\n$/, '');

describe('selectedBlocks', () => {
  it('copies text inside one block as a paragraph, whatever the block', () => {
    expect(cmd.selectedBlocks(select([head.id, 4], [head.id, 9]))).toEqual([expect.objectContaining({ type: 'paragraph', content: plain('title') })]);
    expect(copied(select([head.id, 4], [head.id, 9]))).toBe('title');
    expect(copied(select([item.id, 3], [item.id, 7]))).toBe('item');
    expect(copied(select([head.id, 0], [head.id, 9]))).toBe('Big title');
  });

  it('copies code as a paragraph whose Markdown reads back as the code', () => {
    const blocks = cmd.selectedBlocks(select([code.id, 0], [code.id, 34]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('paragraph');
    const markdown = copied(select([code.id, 0], [code.id, 34]));
    expect(markdown).not.toContain('```');
    const [back] = parseMarkdown(markdown).blocks;
    expect(back!.type).toBe('paragraph');
    expect(isTextBlock(back!) && inlineText(back.content)).toBe('tar cvpf a.tar ~/x\n# second *line*');
  });

  it('keeps the blocks of a selection across blocks, cut at its ends', () => {
    expect(copied(select([head.id, 4], [item.id, 2]))).toBe('## title\n\n- an');
    expect(copied(select([code.id, 19], [head.id, 3]))).toBe('```sh\n# second *line*\n```\n\n## Big');
  });
});
