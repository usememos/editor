// Callouts: GitHub alerts (`> [!NOTE]`) as quote blocks with a `callout` type.

import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import * as cmd from '../src/commands';
import { type Block, caret, createState, type Doc, type EditorState, inlineText, isQuotable, paragraph, plain, quote, withContent } from '../src/model';
import { parseMarkdown } from '../src/markdown/parse';
import { serializeMarkdown } from '../src/markdown/serialize';
import { loadMarkdown } from '../src/markdown/source';
import { docToHtml } from '../src/clipboard/toHtml';
import { htmlToDoc } from '../src/clipboard/fromHtml';

/** "note:text" for a callout, "quote:text" for a plain quote, "p:text" for a paragraph. */
function show(blocks: readonly Block[]): string[] {
  return blocks.map((b) => {
    const text = 'content' in b ? inlineText(b.content) : '';
    if (b.type === 'quote') return `${b.callout ?? 'quote'}:${text}`;
    const quoted = isQuotable(b) && b.quote ? `${b.callout ?? 'quote'}/` : '';
    return `${quoted}${b.type === 'paragraph' ? 'p' : b.type === 'heading' ? `h${b.level}` : b.type}:${text}`;
  });
}
const parse = (md: string, options = {}) => show(parseMarkdown(md, options).blocks);
const md = (...blocks: Block[]) => serializeMarkdown({ blocks });

describe('reading GitHub alerts', () => {
  it('reads each type, in any case, with the marker alone on the first line', () => {
    expect(parse('> [!NOTE]\n> Read this.\n')).toEqual(['note:Read this.']);
    expect(parse('> [!tip]\n> a\n')).toEqual(['tip:a']);
    expect(parse('> [!Important]\n> a\n')).toEqual(['important:a']);
    expect(parse('> [!WARNING]  \n> a\n')).toEqual(['warning:a']);
    expect(parse('> [!CAUTION]\n> a\n')).toEqual(['caution:a']);
  });

  it('marks every paragraph of the blockquote, and keeps the marker paragraph out when it holds only the marker', () => {
    expect(parse('> [!NOTE]\n> one\n> two\n>\n> three\n')).toEqual(['note:one two', 'note:three']);
    expect(parse('> [!NOTE]\n>\n> one\n')).toEqual(['note:one']);
    expect(parse('> [!NOTE]\n> one\n\n> plain\n')).toEqual(['note:one', 'quote:plain']);
  });

  it('reads a marker with nothing after it as an empty callout', () => {
    expect(parse('> [!TIP]\n')).toEqual(['tip:']);
  });

  it('leaves other quotes alone', () => {
    expect(parse('> [!NOTE] on one line\n')).toEqual(['quote:[!NOTE] on one line']);
    expect(parse('> [!FYI]\n> a\n')).toEqual(['quote:[!FYI] a']);
    expect(parse('> text\n> [!NOTE]\n')).toEqual(['quote:text [!NOTE]']);
    expect(parse('[!NOTE]\ntext\n')).toEqual(['p:[!NOTE] text']);
  });

  it('reads the marker as text with callouts: false', () => {
    expect(parse('> [!NOTE]\n> a\n', { callouts: false })).toEqual(['quote:[!NOTE] a']);
  });
});

describe('writing callouts', () => {
  it('writes the marker once, then the paragraphs of one blockquote', () => {
    expect(md(quote(plain('one'), undefined, 'note'), quote(plain('two'), undefined, 'note'))).toBe('> [!NOTE]\n> one\n>\n> two\n');
  });

  it('writes neighbours with another type, or none, as separate blockquotes', () => {
    const blocks = [quote(plain('a'), undefined, 'note'), quote(plain('b'), undefined, 'warning'), quote(plain('c')), quote(plain('d'), undefined, 'tip')];
    const text = md(...blocks);
    expect(text).toBe('> [!NOTE]\n> a\n\n> [!WARNING]\n> b\n\n> c\n\n> [!TIP]\n> d\n');
    expect(parse(text)).toEqual(['note:a', 'warning:b', 'quote:c', 'tip:d']);
  });

  it('writes an empty callout with a no-break space, and reads it back', () => {
    const text = md(quote([], undefined, 'caution'));
    expect(text).toBe('> [!CAUTION]\n> &nbsp;\n');
    expect(parse(text)).toEqual(['caution:']);
  });
});

describe('saving with the source', () => {
  const save = (doc: Doc, source: ReturnType<typeof loadMarkdown>['source']) => serializeMarkdown(doc, { source });

  it('keeps an unchanged callout as written', () => {
    const text = '> [!note]   \n> keep *this*\n\nafter\n';
    const { doc, source } = loadMarkdown(text);
    expect(save(doc, source)).toBe(text);
    const edited = { blocks: doc.blocks.map((b, i) => (i === 1 ? withContent(b as never, plain('changed')) : b)) };
    expect(save(edited, source)).toBe('> [!note]   \n> keep *this*\n\nchanged\n');
  });

  it('keeps a callout as written when a block of the same type is added to it, and apart from a quote of another type', () => {
    const { doc, source } = loadMarkdown('> [!note]\n> a\n');
    const same = { blocks: [...doc.blocks, quote(plain('b'), undefined, 'note')] };
    expect(save(same, source)).toBe('> [!note]\n> a\n>\n> b\n');
    const other = { blocks: [...doc.blocks, quote(plain('b'))] };
    expect(save(other, source)).toBe('> [!note]\n> a\n\n> b\n');
  });
});

describe('commands', () => {
  const state = (blocks: Block[], blockIndex = 0, offset = 0): EditorState => {
    const s = createState({ blocks });
    return { ...s, selection: caret(blocks[blockIndex]!.id, offset) };
  };
  const shown = (s: EditorState | null) => show(s!.doc.blocks);

  it('setCallout changes the type of the whole callout, and null makes it a plain quote', () => {
    const blocks = [paragraph(plain('x')), quote(plain('a'), undefined, 'note'), quote(plain('b'), undefined, 'note'), quote(plain('c'))];
    const s = state(blocks, 2);
    expect(shown(cmd.setCallout(s, blocks[2]!.id, 'warning'))).toEqual(['p:x', 'warning:a', 'warning:b', 'quote:c']);
    expect(shown(cmd.setCallout(s, blocks[1]!.id, null))).toEqual(['p:x', 'quote:a', 'quote:b', 'quote:c']);
    expect(shown(cmd.setCallout(s, blocks[3]!.id, 'tip'))).toEqual(['p:x', 'note:a', 'note:b', 'tip:c']);
    expect(cmd.setCallout(s, blocks[0]!.id, 'tip')).toBe(s);
  });

  it('toggleBlockType makes a callout, and toggles any quote back to paragraphs', () => {
    const s = state([paragraph(plain('a'))]);
    const on = cmd.toggleBlockType(s, { type: 'quote', callout: 'tip' });
    expect(shown(on)).toEqual(['tip:a']);
    expect(shown(cmd.toggleBlockType(on, { type: 'quote', callout: 'warning' }))).toEqual(['warning:a']);
    expect(shown(cmd.toggleBlockType(on, { type: 'quote' }))).toEqual(['p:a']);
    expect(shown(cmd.toggleBlockType(on, { type: 'quote', callout: 'tip' }))).toEqual(['p:a']);
  });

  it('Enter continues the callout, and Enter in an empty line ends it', () => {
    const s = state([quote(plain('ab'), undefined, 'note')], 0, 2);
    const split = cmd.splitBlock(s);
    expect(shown(split)).toEqual(['note:ab', 'note:']);
    expect(shown(cmd.splitBlock(split))).toEqual(['note:ab', 'p:']);
  });

  it('typing a marker and a space makes a callout: of a paragraph, or of the whole quote', () => {
    const typed = (blocks: Block[], index: number, text: string) => {
      const block = blocks[index]!;
      const withText = blocks.map((b) => (b === block ? withContent(b as never, plain(text + inlineText((b as never as { content: [] }).content))) : b));
      return cmd.applyBlockInputRules(state(withText, index, text.length));
    };
    expect(shown(typed([paragraph(plain('x'))], 0, '[!warning] '))).toEqual(['warning:x']);
    expect(shown(typed([quote(plain('a')), quote(plain('b'))], 0, '[!TIP] '))).toEqual(['tip:a', 'tip:b']);
    expect(shown(typed([quote(plain('a'))], 0, '## '))).toEqual(['quote/h2:a']);
    expect(typed([paragraph(plain('x'))], 0, '[!nope] ')).toBeNull();
  });
});

describe('clipboard', () => {
  const window = new Window();
  const parser = new window.DOMParser() as unknown as DOMParser;

  it('copies a callout as a blockquote with GitHub alert classes and a title, and pastes it back', () => {
    const blocks = [quote(plain('a'), undefined, 'tip'), quote(plain('b'), undefined, 'tip'), quote(plain('c'))];
    const html = docToHtml({ blocks });
    expect(html).toBe(
      '<blockquote class="markdown-alert markdown-alert-tip"><p class="markdown-alert-title"><strong>Tip</strong></p><p>a</p><p>b</p></blockquote><blockquote><p>c</p></blockquote>',
    );
    expect(show(htmlToDoc(html, parser).blocks)).toEqual(['tip:a', 'tip:b', 'quote:c']);
  });

  it('pastes an alert copied from a GitHub page', () => {
    const html =
      '<div class="markdown-alert markdown-alert-warning" dir="auto"><p class="markdown-alert-title" dir="auto"><svg></svg>Warning</p><p dir="auto">Be careful.</p></div>';
    expect(show(htmlToDoc(html, parser).blocks)).toEqual(['warning:Be careful.']);
  });
});
