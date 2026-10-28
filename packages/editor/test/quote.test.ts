// Lists inside quotes and callouts: list items marked as quoted, next to the
// quote's paragraphs.

import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import * as cmd from '../src/commands';
import { docToHtml } from '../src/clipboard/toHtml';
import { htmlToDoc } from '../src/clipboard/fromHtml';
import { serializeMarkdown } from '../src/markdown/serialize';
import { codeBlock, divider, emptyTable, heading, withQuote } from '../src/model';
import { stripQuoteMarker } from '../src/markdown/lower';
import { loadMarkdown } from '../src/markdown/source';
import { type Block, type EditorState, type QuoteKind, caret, createState, inlineText, isQuotable, listItem, paragraph, plain, quote, startsQuote, withContent } from '../src/model';

/**
 * "quote:a" for a quote paragraph, "quote/bullet:0 a" for a quoted item, "quote/h2:a" for a quoted heading
 * (and "quote/code:", "quote/table:", "quote/hr", "quote/raw:" likewise), "note/..." in a callout, and
 * "new quote:a" for a block that starts a new blockquote after one of the same kind.
 */
function show(blocks: readonly Block[]): string[] {
  return blocks.map((b) => {
    const text = 'content' in b ? inlineText(b.content) : '';
    const fresh = startsQuote(b) ? 'new ' : '';
    if (b.type === 'quote') return `${fresh}${b.callout ?? 'quote'}:${text}`;
    const quoted = isQuotable(b) && b.quote ? `${fresh}${b.callout ?? 'quote'}/` : '';
    if (b.type === 'listItem') return `${quoted}${b.listType}:${b.indent} ${text}`;
    if (b.type === 'heading') return `${quoted}h${b.level}:${text}`;
    if (b.type === 'divider') return `${quoted}hr`;
    if (b.type === 'table') return `${quoted}table:${b.rows.map((r) => r.map(inlineText).join('|')).join('/')}`;
    return `${quoted}${b.type === 'paragraph' ? 'p' : b.type}:${text}`;
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

  it('block markers apply in a quote and keep the block in it; a quote or section marker does not', () => {
    const typed = (block: Block, text: string) => cmd.applyBlockInputRules(state([withContent(block as never, plain(text + 'x'))], 0, text.length));
    expect(shown(typed(quote([], undefined, 'tip'), '1. '))).toEqual(['tip/ordered:0 x']);
    expect(shown(typed(quote([]), '[ ] '))).toEqual(['quote/task:0 x']);
    expect(shown(typed(item('', 'note'), '[ ] '))).toEqual(['note/task:0 x']);
    expect(shown(typed(quote([]), '# '))).toEqual(['quote/h1:x']);
    expect(shown(typed(quote([], undefined, 'tip'), '```js '))).toEqual(['tip/code:x']);
    expect(shown(typed(quote([]), '---'))).toEqual(['quote/hr', 'quote:x']);
    expect(typed(quote([]), '> ')).toBeNull();
    expect(typed(quote([]), '>>> ')).toBeNull();
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

describe('separate quotes', () => {
  // Two quotes with a blank line between them in Markdown.
  const load = () => {
    const blocks = loadMarkdown('> a\n>\n> b\n\n> c\n>\n> d\n').doc.blocks.slice();
    return { blocks, save: (s: EditorState) => serializeMarkdown(s.doc) };
  };

  it('stay separate when the second is edited', () => {
    const { blocks, save } = load();
    expect(show(blocks)).toEqual(['quote:a', 'quote:b', 'new quote:c', 'quote:d']);
    // Enter in the middle of its first line.
    let s = cmd.splitBlock(state(blocks, 2, 1));
    expect(shown(s)).toEqual(['quote:a', 'quote:b', 'new quote:c', 'quote:', 'quote:d']);
    // Enter at the start of its first line: the new empty line is part of the second quote.
    s = cmd.splitBlock(state(blocks, 2, 0));
    expect(shown(s)).toEqual(['quote:a', 'quote:b', 'new quote:', 'quote:c', 'quote:d']);
    expect(save(s)).toBe('> a\n>\n> b\n\n> &nbsp;\n>\n> c\n>\n> d\n');
  });

  it('stay separate when the first line of the second becomes a list item and back', () => {
    const { blocks, save } = load();
    let s = cmd.applyBlockInputRules(cmd.insertText(state(blocks, 2, 0), '- '))!;
    expect(shown(s)).toEqual(['quote:a', 'quote:b', 'new quote/bullet:0 c', 'quote:d']);
    expect(save(s)).toBe('> a\n>\n> b\n\n> - c\n>\n> d\n');
    s = cmd.deleteBackward(s);
    expect(shown(s)).toEqual(['quote:a', 'quote:b', 'new quote:c', 'quote:d']);
  });

  it('change their callout one at a time', () => {
    const { blocks } = load();
    expect(shown(cmd.setCallout(state(blocks), blocks[0]!.id, 'note'))).toEqual(['note:a', 'note:b', 'new quote:c', 'quote:d']);
    expect(shown(cmd.setCallout(state(blocks), blocks[3]!.id, 'note'))).toEqual(['quote:a', 'quote:b', 'new note:c', 'note:d']);
  });

  it('copy as two blockquotes and paste back as two', () => {
    const { blocks } = load();
    const html = docToHtml({ blocks });
    expect(html).toBe('<blockquote><p>a</p><p>b</p></blockquote><blockquote><p>c</p><p>d</p></blockquote>');
    const parser = new new Window().DOMParser() as unknown as DOMParser;
    expect(show(htmlToDoc(html, parser).blocks)).toEqual(['quote:a', 'quote:b', 'new quote:c', 'quote:d']);
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

// A web clipper quotes a whole page, so a quote holds headings, lists, tables and code.
describe('blocks other than paragraphs and lists in a quote', () => {
  const clip = [
    '> ## Why room matters',
    '>',
    '> Leave a little room in your day. It is **easy** to fill every gap.',
    '>',
    '> - Walk before email',
    '> - Write one line',
    '>   - Even a bad one',
    '>',
    '> | Habit | Minutes |',
    '> | --- | --- |',
    '> | Walk | 20 |',
    '>',
    '> ```js',
    '> const room = plan.filter((slot) => !slot.busy);',
    '> ```',
    '',
    'A short summary.',
    '',
    '[A little room to think](https://fieldnotes.example/a-little-room)',
    '',
  ].join('\n');
  const options = { breaks: true, setext: false };

  it('loads each block as its own quoted block, with no raw block, and saves unchanged', () => {
    const { doc, source } = loadMarkdown(clip, options);
    expect(show(doc.blocks)).toEqual([
      'quote/h2:Why room matters',
      'quote:Leave a little room in your day. It is easy to fill every gap.',
      'quote/bullet:0 Walk before email',
      'quote/bullet:0 Write one line',
      'quote/bullet:1 Even a bad one',
      'quote/table:Habit|Minutes/Walk|20',
      'quote/code:const room = plan.filter((slot) => !slot.busy);',
      'p:A short summary.',
      'p:A little room to think',
    ]);
    expect(serializeMarkdown(doc, { ...options, source })).toBe(clip);
  });

  it('saves an edited block with the quote prefix on every line, the rest of the quote as written', () => {
    const { doc, source } = loadMarkdown(clip, options);
    const s = cmd.insertText(state(doc.blocks.slice(), 0, 16), '!');
    expect(serializeMarkdown(s.doc, { ...options, source })).toBe(clip.replace('## Why room matters', '## Why room matters!'));
  });

  it('keeps the blocks of a quote that were not edited as written, with the text between them', () => {
    // Turndown writes `_italic_` and `* ` bullets; only the edited block is written in the normalized style.
    const text = '> ## Why _room_ matters\n>\n> Leave _a_ little room.\n>\n>\n> * Walk\n> * Write\n';
    const { doc, source } = loadMarkdown(text);
    expect(serializeMarkdown(doc, { source })).toBe(text);
    const edit = (index: number, offset: number) => serializeMarkdown(cmd.insertText(state(doc.blocks.slice(), index, offset), '!').doc, { source });
    expect(edit(0, 16)).toBe('> ## Why *room* matters!\n>\n> Leave _a_ little room.\n>\n>\n> * Walk\n> * Write\n');
    // One blank quote line separates the edited block from a kept neighbour, whatever stood between them.
    expect(edit(1, 20)).toBe('> ## Why _room_ matters\n>\n> Leave *a* little room.!\n>\n> * Walk\n> * Write\n');
    // The list is one block of the quote: an edit to one item writes the whole list.
    expect(edit(3, 5)).toBe('> ## Why _room_ matters\n>\n> Leave _a_ little room.\n>\n> - Walk\n> - Write!\n');
  });

  it('separates an edited block from a kept neighbour with a blank quote line, whatever was between them', () => {
    const { doc, source } = loadMarkdown('> # H\n> text\n> * a\n');
    const s = cmd.insertText(state(doc.blocks.slice(), 1, 4), '!');
    expect(serializeMarkdown(s.doc, { source })).toBe('> # H\n>\n> text!\n>\n> * a\n');
    // A setext heading keeps its underline.
    const setext = loadMarkdown('> Title\n> ===\n> text\n');
    expect(serializeMarkdown(cmd.insertText(state(setext.doc.blocks.slice(), 1, 4), '!').doc, { source: setext.source })).toBe('> Title\n> ===\n>\n> text!\n');
  });

  it('keeps a callout marker as written while its first block is kept, and writes it when that block changes or goes', () => {
    const text = '> [!note]\n> First _para_.\n>\n> * item\n';
    const { doc, source } = loadMarkdown(text);
    expect(serializeMarkdown(cmd.insertText(state(doc.blocks.slice(), 1, 4), '!').doc, { source })).toBe('> [!note]\n> First _para_.\n>\n> - item!\n');
    expect(serializeMarkdown(cmd.insertText(state(doc.blocks.slice(), 0, 11), '!').doc, { source })).toBe('> [!NOTE]\n> First *para*.!\n>\n> * item\n');
    expect(serializeMarkdown({ blocks: doc.blocks.slice(1) }, { source })).toBe('> [!NOTE]\n> * item\n');
    // Enter at the start of the first line: the new empty line comes first, the marker before it.
    const s = cmd.splitBlock(state(doc.blocks.slice(), 0, 0));
    expect(serializeMarkdown(s.doc, { source })).toBe('> [!NOTE]\n> &nbsp;\n>\n> First _para_.\n>\n> * item\n');
  });

  it('writes the parts of a quote split in two from their source, and lists that would merge through the serializer', () => {
    const { doc, source } = loadMarkdown('> _a_\n>\n> b\n>\n> _c_\n');
    const split = cmd.toggleBlockType(state(doc.blocks.slice(), 1, 0), { type: 'quote' });
    expect(show(split.doc.blocks)).toEqual(['quote:a', 'p:b', 'quote:c']);
    expect(serializeMarkdown(split.doc, { source })).toBe('> _a_\n\nb\n\n> _c_\n');
    // A new item after a kept list would join it: both are written through the serializer, as one list.
    const list = loadMarkdown('> * _a_\n>\n> p\n');
    const [a, p] = list.doc.blocks;
    expect(serializeMarkdown({ blocks: [a!, listItem('bullet', plain('x'), { quote: 'quote' }), p!] }, { source: list.source })).toBe('> - *a*\n> - x\n>\n> p\n');
    // Indented code after a block that became a list item would become part of the item; it is written through the serializer too.
    const code = loadMarkdown('> p\n>\n>     code\n');
    const edited = cmd.toggleBlockType(state(code.doc.blocks.slice(), 0, 0), { type: 'listItem', listType: 'bullet' });
    expect(serializeMarkdown(edited.doc, { source: code.source })).toBe('> - p\n>\n> ```\n> code\n> ```\n');
    // A fence without its closing line would swallow a block added after it.
    const open = loadMarkdown('> p\n>\n> ```\n> code\n');
    const after = { blocks: [...open.doc.blocks, quote(plain('after'))] };
    expect(serializeMarkdown(after, { source: open.source })).toBe('> p\n>\n> ```\n> code\n> ```\n>\n> after\n');
  });

  it('keeps a quote inside a quote, or a list it cannot hold, as a quoted raw block; the siblings stay blocks', () => {
    const text = '> a\n>\n> > inner\n> > more\n>\n> - item\n>\n>   second paragraph\n>\n> ## h\n';
    const { doc, source } = loadMarkdown(text);
    expect(show(doc.blocks)).toEqual(['quote:a', 'quote/raw:> inner\n> more', 'quote/raw:- item\n\n  second paragraph', 'quote/h2:h']);
    expect(serializeMarkdown(doc, { source })).toBe(text);
    // Edited, the raw blocks are written as they are, with the quote prefix.
    const s = cmd.insertText(state(doc.blocks.slice(), 3, 1), '!');
    expect(serializeMarkdown(s.doc, { source })).toBe('> a\n>\n> > inner\n> > more\n>\n> - item\n>\n>   second paragraph\n>\n> ## h!\n');
  });

  it('separate quotes stay separate when the second starts with a heading', () => {
    const { doc, source } = loadMarkdown('> a\n\n> # b\n');
    expect(show(doc.blocks)).toEqual(['quote:a', 'new quote/h1:b']);
    expect(serializeMarkdown(doc, { source })).toBe('> a\n\n> # b\n');
    expect(serializeMarkdown(doc)).toBe('> a\n\n> # b\n');
  });

  it('Enter at the end of a quoted heading starts a paragraph of the quote, and in a quoted code block a line', () => {
    let s = state([quote(plain('q')), cmd.setBlockType(state([quote(plain('Title'))]), { type: 'heading', level: 2 }).doc.blocks[0]!], 1, 5);
    expect(shown(s)).toEqual(['quote:q', 'quote/h2:Title']);
    s = cmd.insertText(cmd.splitBlock(s), 'text');
    expect(shown(s)).toEqual(['quote:q', 'quote/h2:Title', 'quote:text']);
    // Enter in the middle of the heading splits it into two quoted headings.
    s = cmd.splitBlock(state(s.doc.blocks.slice(), 1, 2));
    expect(shown(s)).toEqual(['quote:q', 'quote/h2:Ti', 'quote/h2:tle', 'quote:text']);
    // Enter at the start of the first block of a second quote keeps the boundary.
    const [a, b] = loadMarkdown('> a\n\n> # b').doc.blocks;
    s = cmd.splitBlock(state([a!, b!], 1, 0));
    expect(shown(s)).toEqual(['quote:a', 'new quote:', 'quote/h1:b']);
    expect(serializeMarkdown(s.doc)).toBe('> a\n\n> &nbsp;\n>\n> # b\n');
    // In a quoted code block, Enter adds a line; two Enters on an empty last line leave the block for a paragraph of the quote.
    const code = cmd.setBlockType(state([quote(plain('x'))]), { type: 'code', language: 'js' });
    expect(shown(code)).toEqual(['quote/code:x']);
    s = cmd.splitBlock(cmd.splitBlock(cmd.splitBlock(state(code.doc.blocks.slice(), 0, 1))));
    expect(shown(s)).toEqual(['quote/code:x', 'quote:']);
  });

  it('Backspace at the start of a quoted heading or code block makes it a paragraph of the quote, then a plain paragraph', () => {
    const { doc } = loadMarkdown('> ## h\n>\n> ```\n> c\n> ```');
    let s = cmd.deleteBackward(state(doc.blocks.slice(), 0, 0));
    expect(shown(s)).toEqual(['quote:h', 'quote/code:c']);
    s = cmd.deleteBackward(s);
    expect(shown(s)).toEqual(['p:h', 'quote/code:c']);
    s = cmd.deleteBackward(state(doc.blocks.slice(), 1, 0));
    expect(shown(s)).toEqual(['quote/h2:h', 'quote:c']);
  });

  it('typing "# ", "```" and "---" in a quote makes a heading, code block or divider in the quote', () => {
    let s = state([quote(plain('q')), quote(plain('x'))], 1, 0);
    s = cmd.applyBlockInputRules(cmd.insertText(s, '## '))!;
    expect(shown(s)).toEqual(['quote:q', 'quote/h2:x']);
    s = cmd.splitBlock({ ...s, selection: caret(s.doc.blocks[1]!.id, 1) });
    s = cmd.splitBlock(cmd.insertText(s, '```js'));
    expect(shown(s)).toEqual(['quote:q', 'quote/h2:x', 'quote/code:']);
    s = cmd.applyBlockInputRules(cmd.insertText(state([quote(plain('q')), quote(plain('rest'))], 1, 0), '---'))!;
    expect(shown(s)).toEqual(['quote:q', 'quote/hr', 'quote:rest']);
    // The first block of a second quote keeps the boundary.
    const [a, b] = loadMarkdown('> a\n\n> b').doc.blocks;
    s = cmd.applyBlockInputRules(cmd.insertText(state([a!, b!], 1, 0), '---'))!;
    expect(shown(s)).toEqual(['quote:a', 'new quote/hr', 'quote:b']);
    expect(serializeMarkdown(s.doc)).toBe('> a\n\n> ---\n>\n> b\n');
  });

  it('the block type commands keep a block in its quote, and the quote toggle takes it out', () => {
    const { doc } = loadMarkdown('> ## h\n>\n> text');
    let s = cmd.toggleBlockType(state(doc.blocks.slice(), 0, 0), { type: 'heading', level: 2 });
    expect(shown(s)).toEqual(['quote:h', 'quote:text']);
    s = cmd.toggleBlockType(state(doc.blocks.slice(), 1, 0), { type: 'heading', level: 3 });
    expect(shown(s)).toEqual(['quote/h2:h', 'quote/h3:text']);
    s = cmd.toggleBlockType(state(doc.blocks.slice(), 0, 0), { type: 'listItem', listType: 'bullet' });
    expect(shown(s)).toEqual(['quote/bullet:0 h', 'quote:text']);
    s = cmd.toggleBlockType(state(doc.blocks.slice(), 0, 0), { type: 'code' });
    expect(shown(s)).toEqual(['quote/code:h', 'quote:text']);
    // The quote toggle on a quoted heading leaves the quote and keeps the heading; on a heading outside, it quotes it.
    s = cmd.toggleBlockType(state(doc.blocks.slice(), 0, 0), { type: 'quote' });
    expect(shown(s)).toEqual(['h2:h', 'quote:text']);
    s = cmd.toggleBlockType(state([heading(2, plain('h'))], 0, 0), { type: 'quote', callout: 'tip' });
    expect(shown(s)).toEqual(['tip/h2:h']);
    expect(serializeMarkdown(s.doc)).toBe('> [!TIP]\n> ## h\n');
  });

  it('the slash menu puts a table or divider made in a quote into the quote', () => {
    let s = cmd.insertBlock(state([quote(plain('q')), quote([])], 1, 0), { type: 'table', rows: 2, cols: 2 });
    expect(shown(s)).toEqual(['quote:q', 'quote/table:|/|']);
    s = cmd.insertBlock(state([quote(plain('q'))], 0, 1), { type: 'divider' });
    expect(shown(s)).toEqual(['quote:q', 'quote/hr', 'quote:']);
    expect(serializeMarkdown(s.doc)).toBe('> q\n>\n> ---\n>\n> &nbsp;\n');
  });

  it('setCallout and the callout marker change the whole quote, headings and code included', () => {
    const { doc } = loadMarkdown('> ## h\n>\n> ```\n> c\n> ```\n>\n> ---\n>\n> text');
    const s = cmd.setCallout(state(doc.blocks.slice(), 3, 0), doc.blocks[3]!.id, 'warning');
    expect(shown(s)).toEqual(['warning/h2:h', 'warning/code:c', 'warning/hr', 'warning:text']);
    expect(serializeMarkdown(s.doc)).toBe('> [!WARNING]\n> ## h\n>\n> ```\n> c\n> ```\n>\n> ---\n>\n> text\n');
    expect(cmd.quoteRun(s, doc.blocks[0]!.id)).toEqual({ start: 0, end: 3 });
  });

  it('serializes every quoted block type with the prefix on every line', () => {
    const blocks = [
      heading(1, plain('H')),
      codeBlock('js', 'a\n\nb'),
      emptyTable(2, 2),
      divider(),
      paragraph(plain('p')),
    ].map((b) => withQuote(b, 'quote'));
    expect(serializeMarkdown({ blocks })).toBe('> # H\n>\n> ```js\n> a\n>\n> b\n> ```\n>\n> |  |  |\n> | --- | --- |\n> |  |  |\n>\n> ---\n>\n> p\n');
  });

  it('copies quoted headings, code and tables in one blockquote, and pastes them back', () => {
    const window = new Window();
    const parser = new window.DOMParser() as unknown as DOMParser;
    const { doc } = loadMarkdown('> [!NOTE]\n> ## h\n>\n> ```js\n> c\n> ```\n>\n> | a |\n> | - |\n> | b |\n>\n> ---');
    const html = docToHtml(doc);
    expect(html).toBe(
      '<blockquote class="markdown-alert markdown-alert-note"><p class="markdown-alert-title"><strong>Note</strong></p><h2>h</h2><pre><code class="language-js">c</code></pre><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table><hr></blockquote>',
    );
    expect(show(htmlToDoc(html, parser).blocks)).toEqual(['note/h2:h', 'note/code:c', 'note/table:a/b', 'note/hr']);
  });
});

describe('the quote marker of a raw block inside a quote', () => {
  it('is read as CommonMark reads it: up to three spaces, ">", and one space, with tabs at stops of 4', () => {
    expect(stripQuoteMarker('> foo')).toBe('foo');
    expect(stripQuoteMarker('>foo')).toBe('foo');
    expect(stripQuoteMarker('   > foo')).toBe('foo');
    expect(stripQuoteMarker('>     code')).toBe('    code');
    // CommonMark example 6: the tabs stand for six columns of indentation after the marker.
    expect(stripQuoteMarker('>\t\tfoo')).toBe('      foo');
    expect(stripQuoteMarker('>\tfoo')).toBe('  foo');
    expect(stripQuoteMarker('> \tfoo')).toBe('  foo');
    // No marker: a lazy continuation line.
    expect(stripQuoteMarker('lazy')).toBe('lazy');
    expect(stripQuoteMarker('    > not a marker')).toBe('    > not a marker');
  });

  it('gives a quote inside a quote the source CommonMark gives it, whatever follows the outer marker', () => {
    const text = '> a\n>\n>\t> b\n>\t\t    c\n';
    const { doc, source } = loadMarkdown(text);
    expect(show(doc.blocks)).toEqual(['quote:a', 'quote/raw:  > b\n          c']);
    expect(serializeMarkdown(doc, { source })).toBe(text);
    // Edited, the raw block is written with the spaces its tabs stood for; it reads back the same.
    const edited = cmd.insertText(state(doc.blocks.slice(), 1, '  > b\n          c'.length), '!');
    const saved = serializeMarkdown(edited.doc, { source });
    expect(saved).toBe('> a\n>\n>   > b\n>           c!\n');
    expect(show(loadMarkdown(saved).doc.blocks)).toEqual(['quote:a', 'quote/raw:  > b\n          c!']);
  });
});

describe('review fixes', () => {
  it('keeps a paragraph after an edited list as written: the marker space is not indentation', () => {
    const { doc, source } = loadMarkdown('> * a\n>\n> _text_\n');
    const s = cmd.insertText(state(doc.blocks.slice(), 0, 1), '!');
    expect(serializeMarkdown(s.doc, { source })).toBe('> - a!\n>\n> _text_\n');
  });

  it('leaves the blank quote lines at the end of a quote to its tail', () => {
    const { doc, source } = loadMarkdown('> _a_\n>\n>\n');
    expect(serializeMarkdown(doc, { source })).toBe('> _a_\n>\n>\n');
    const appended = { blocks: [...doc.blocks, quote(plain('b'))] };
    expect(serializeMarkdown(appended, { source })).toBe('> _a_\n>\n> b\n');
  });

  it('the paragraph style leaves the quote from a quote paragraph, and gives a paragraph of the quote from a heading in it', () => {
    const { doc } = loadMarkdown('> ## h\n>\n> text\n');
    expect(shown(cmd.setBlockType(state(doc.blocks.slice(), 1, 0), { type: 'paragraph' }))).toEqual(['quote/h2:h', 'p:text']);
    expect(shown(cmd.setBlockType(state(doc.blocks.slice(), 0, 0), { type: 'paragraph' }))).toEqual(['quote:h', 'quote:text']);
  });

  it('withQuote returns the block itself when nothing changes, so the save keeps it as written', () => {
    const { doc, source } = loadMarkdown('> _a_\n>\n> ## h\n\nplain\n');
    const [a, h, p] = doc.blocks;
    expect(withQuote(a!, 'quote')).toBe(a);
    expect(withQuote(h!, 'quote')).toBe(h);
    expect(withQuote(p!, null)).toBe(p);
    // The quote toggle over the quote and the paragraph after it quotes the paragraph and keeps the quote's blocks as written.
    const s = cmd.toggleBlockType({ ...createState(doc), selection: { anchor: { blockId: a!.id, offset: 0 }, focus: { blockId: p!.id, offset: 0 } } }, { type: 'quote' });
    expect(shown(s)).toEqual(['quote:a', 'quote/h2:h', 'quote:plain']);
    expect(serializeMarkdown(s.doc, { source })).toBe('> _a_\n>\n> ## h\n>\n> plain\n');
  });
});
