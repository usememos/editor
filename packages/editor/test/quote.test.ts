// Lists inside quotes and callouts: list items marked as quoted, next to the
// quote's paragraphs.

import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import * as cmd from '../src/commands';
import { docToHtml } from '../src/clipboard/toHtml';
import { htmlToDoc } from '../src/clipboard/fromHtml';
import { serializeMarkdown } from '../src/markdown/serialize';
import { loadMarkdown } from '../src/markdown/source';
import { type Block, type EditorState, type QuoteKind, caret, createState, inlineText, listItem, paragraph, plain, quote, withContent } from '../src/model';

/** "quote:a" for a quote paragraph, "quote/bullet:0 a" for a quoted item, "note/..." in a callout. */
function show(blocks: readonly Block[]): string[] {
  return blocks.map((b) => {
    const text = 'content' in b ? inlineText(b.content) : '';
    if (b.type === 'quote') return `${b.callout ?? 'quote'}:${text}`;
    if (b.type === 'listItem') return `${b.quote ? `${b.callout ?? 'quote'}/` : ''}${b.listType}:${b.indent} ${text}`;
    return `${b.type === 'paragraph' ? 'p' : b.type}:${text}`;
  });
}

const state = (blocks: Block[], blockIndex = 0, offset = 0): EditorState => ({
  ...createState({ blocks }),
  selection: caret(blocks[blockIndex]!.id, offset),
});
const shown = (s: EditorState | null) => show(s!.doc.blocks);
const item = (text: string, quote: QuoteKind | null = 'quote', indent = 0) =>
  listItem('bullet', plain(text), { indent, quote });

describe('the reported memo', () => {
  const text = '> ✏️ **quick note**\n> * Item 1: check xyz\n> * Item 2: check abc\n';

  it('loads as a quote paragraph and a list in the quote, and saves unchanged', () => {
    const { doc, source } = loadMarkdown(text, { breaks: true });
    expect(show(doc.blocks)).toEqual(['quote:✏️ quick note', 'quote/bullet:0 Item 1: check xyz', 'quote/bullet:0 Item 2: check abc']);
    expect(serializeMarkdown(doc, { breaks: true, source })).toBe(text);
  });

  it('can be typed: a quote, Enter, then "- " starts a list in the quote', () => {
    let s = state([quote(plain('quick note'))], 0, 10);
    s = cmd.splitBlock(s);
    s = cmd.applyBlockInputRules(cmd.insertText(s, '- '))!;
    s = cmd.insertText(s, 'Item 1');
    s = cmd.insertText(cmd.splitBlock(s), 'Item 2');
    expect(shown(s)).toEqual(['quote:quick note', 'quote/bullet:0 Item 1', 'quote/bullet:0 Item 2']);
    expect(serializeMarkdown(s.doc)).toBe('> quick note\n>\n> - Item 1\n> - Item 2\n');
  });
});

describe('commands', () => {
  it('Enter in an empty quoted item outdents, then ends the list with a paragraph of the quote, then leaves the quote', () => {
    let s = state([quote(plain('q')), item('a'), item('', 'quote', 1)], 2, 0);
    s = cmd.splitBlock(s);
    expect(shown(s)).toEqual(['quote:q', 'quote/bullet:0 a', 'quote/bullet:0 ']);
    s = cmd.splitBlock(s);
    expect(shown(s)).toEqual(['quote:q', 'quote/bullet:0 a', 'quote:']);
    s = cmd.splitBlock(s);
    expect(shown(s)).toEqual(['quote:q', 'quote/bullet:0 a', 'p:']);
  });

  it('Enter in a quoted item continues the list in the same callout', () => {
    const s = cmd.splitBlock(state([item('ab', 'note')], 0, 2));
    expect(shown(s)).toEqual(['note/bullet:0 ab', 'note/bullet:0 ']);
  });

  it('Backspace at the start of a quoted item makes it a paragraph of the quote, then a plain paragraph', () => {
    let s = state([quote(plain('q')), item('a', 'note')], 1, 0);
    s = cmd.deleteBackward(s);
    expect(shown(s)).toEqual(['quote:q', 'note:a']);
    s = cmd.deleteBackward(s);
    expect(shown(s)).toEqual(['quote:q', 'p:a']);
  });

  it('list markers apply in a quote and keep the item in it; other markers do not', () => {
    const typed = (block: Block, text: string) => cmd.applyBlockInputRules(state([withContent(block as never, plain(text + 'x'))], 0, text.length));
    expect(shown(typed(quote([], undefined, 'tip'), '1. '))).toEqual(['tip/ordered:0 x']);
    expect(shown(typed(quote([]), '[ ] '))).toEqual(['quote/task:0 x']);
    expect(shown(typed(item('', 'note'), '[ ] '))).toEqual(['note/task:0 x']);
    expect(typed(quote([]), '# ')).toBeNull();
  });

  it('toggling a list off in a quote keeps the text in the quote; toggling the quote off keeps the list', () => {
    const s = state([quote(plain('q')), item('a'), item('b')], 1, 0);
    expect(shown(cmd.toggleBlockType(s, { type: 'listItem', listType: 'bullet' }))).toEqual(['quote:q', 'quote:a', 'quote/bullet:0 b']);
    expect(shown(cmd.toggleBlockType(s, { type: 'quote' }))).toEqual(['quote:q', 'bullet:0 a', 'quote/bullet:0 b']);
    expect(shown(cmd.toggleBlockType(s, { type: 'listItem', listType: 'ordered' }))).toEqual(['quote:q', 'quote/ordered:0 a', 'quote/bullet:0 b']);
  });

  it('making list items a quote or callout keeps them list items', () => {
    const s = state([item('a', null), item('b', null, 1)], 0, 0);
    const all = { ...s, selection: { anchor: caret(s.doc.blocks[0]!.id, 0).anchor, focus: caret(s.doc.blocks[1]!.id, 1).focus } };
    expect(shown(cmd.toggleBlockType(all, { type: 'quote' }))).toEqual(['quote/bullet:0 a', 'quote/bullet:1 b']);
    expect(shown(cmd.toggleBlockType(all, { type: 'quote', callout: 'warning' }))).toEqual(['warning/bullet:0 a', 'warning/bullet:1 b']);
  });

  it('setCallout changes the whole callout, its list included', () => {
    const blocks = [quote(plain('q'), undefined, 'note'), item('a', 'note'), quote(plain('c'), undefined, 'note'), item('d', null)];
    const s = state(blocks, 1);
    expect(shown(cmd.setCallout(s, blocks[1]!.id, 'tip'))).toEqual(['tip:q', 'tip/bullet:0 a', 'tip:c', 'bullet:0 d']);
    expect(shown(cmd.setCallout(s, blocks[0]!.id, null))).toEqual(['quote:q', 'quote/bullet:0 a', 'quote:c', 'bullet:0 d']);
  });

  it('a list in a quote and a list outside it are separate lists for nesting', () => {
    const s = state([item('a', null), item('b', 'quote', 1)], 1, 0);
    expect(shown(cmd.clampListIndents(s, state([paragraph()])))).toEqual(['bullet:0 a', 'quote/bullet:0 b']);
    expect(cmd.indentListItems(state([item('a', null), item('b')], 1, 0), 1).doc.blocks[1]).toMatchObject({ indent: 0 });
  });
});

describe('saving', () => {
  it('rewrites one byte when a task in a callout is ticked', () => {
    const text = '> [!NOTE]\n> To do:\n>  - [ ] one\n>  - [ ] two\n';
    const { doc, source } = loadMarkdown(text);
    const ticked = cmd.toggleTask(createState(doc), doc.blocks[2]!.id).doc;
    expect(serializeMarkdown(ticked, { source })).toBe('> [!NOTE]\n> To do:\n>  - [ ] one\n>  - [x] two\n');
  });

  it('writes a quote next to a list as separate blocks', () => {
    expect(serializeMarkdown({ blocks: [item('a'), item('b', null)] })).toBe('> - a\n\n- b\n');
    expect(serializeMarkdown({ blocks: [item('a', 'note'), item('b')] })).toBe('> [!NOTE]\n> - a\n\n> - b\n');
  });
});

describe('clipboard', () => {
  const window = new Window();
  const parser = new window.DOMParser() as unknown as DOMParser;

  it('copies a quote with a list as one blockquote, and pastes it back', () => {
    const blocks = [quote(plain('q'), undefined, 'tip'), item('a', 'tip'), item('b', 'tip', 1)];
    const html = docToHtml({ blocks });
    expect(html).toBe(
      '<blockquote class="markdown-alert markdown-alert-tip"><p class="markdown-alert-title"><strong>Tip</strong></p><p>q</p><ul><li>a<ul><li>b</li></ul></li></ul></blockquote>',
    );
    expect(show(htmlToDoc(html, parser).blocks)).toEqual(['tip:q', 'tip/bullet:0 a', 'tip/bullet:1 b']);
  });
});
