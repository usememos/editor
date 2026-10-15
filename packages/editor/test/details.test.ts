// Collapsible sections: `<details>` with a `<summary>`, edited in place as a
// title block, the blocks inside, and an end block.

import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import * as cmd from '../src/commands';
import { type Block, type Doc, type EditorState, caret, createState, details, detailsEnd, inlineText, paragraph, plain, withContent } from '../src/model';
import { parseMarkdown } from '../src/markdown/parse';
import { serializeMarkdown } from '../src/markdown/serialize';
import { loadMarkdown } from '../src/markdown/source';
import { docToHtml } from '../src/clipboard/toHtml';
import { htmlToDoc } from '../src/clipboard/fromHtml';

/** "details:title" (with "+" when saved open), "/details", "p:text", or "type:text". */
function show(blocks: readonly Block[]): string[] {
  return blocks.map((b) => {
    if (b.type === 'detailsEnd') return '/details';
    const text = 'content' in b ? inlineText(b.content) : '';
    if (b.type === 'details') return `details${b.open ? '+' : ''}:${text}`;
    return `${b.type === 'paragraph' ? 'p' : b.type}:${text}`;
  });
}
const parse = (md: string, options = {}) => show(parseMarkdown(md, options).blocks);
const md = (...blocks: Block[]) => serializeMarkdown({ blocks });

describe('reading <details>', () => {
  it('reads a title, the blocks inside, and an end', () => {
    expect(parse('<details>\n<summary>Title</summary>\n\nBody\n\n</details>\n')).toEqual(['details:Title', 'p:Body', '/details']);
    expect(parse('<details>\n<summary>T</summary>\n\n# H\n\n- a\n\n</details>\n')).toEqual(['details:T', 'heading:H', 'listItem:a', '/details']);
  });

  it('reads the open attribute in its HTML spellings', () => {
    for (const open of ['open', 'open=""', "open=''", 'open="open"', 'OPEN']) {
      expect(parse(`<details ${open}>\n<summary>T</summary>\n\nx\n\n</details>\n`)).toEqual(['details+:T', 'p:x', '/details']);
    }
  });

  it('decodes character references in the title, and reads an empty title', () => {
    expect(parse('<details>\n<summary>a &amp; &lt;b&gt;</summary>\n\nx\n\n</details>\n')).toEqual(['details:a & <b>', 'p:x', '/details']);
    expect(parse('<details>\n<summary></summary>\n\nx\n\n</details>\n')).toEqual(['details:', 'p:x', '/details']);
  });

  it('nests sections', () => {
    expect(parse('<details>\n<summary>A</summary>\n\n<details>\n<summary>B</summary>\n\nx\n\n</details>\n\ny\n\n</details>\n')).toEqual([
      'details:A',
      'details:B',
      'p:x',
      '/details',
      'p:y',
      '/details',
    ]);
  });

  it('leaves other shapes as raw HTML', () => {
    // An end with nothing open, a title with no end, and a title with markup in it (one HTML block).
    expect(parse('</details>\n')).toEqual(['raw:</details>']);
    expect(parse('<details>\n<summary>T</summary>\n\nx\n')).toEqual(['raw:<details>\n<summary>T</summary>', 'p:x']);
    expect(parse('<details>\n<summary><b>T</b></summary>\n\nx\n\n</details>\n')).toEqual(['raw:<details>\n<summary><b>T</b></summary>\n\nx\n\n</details>']);
  });

  it('reads <details> as raw HTML with details: false', () => {
    expect(parse('<details>\n<summary>T</summary>\n\nx\n\n</details>\n', { details: false })).toEqual([
      'raw:<details>\n<summary>T</summary>\n\nx\n\n</details>',
    ]);
  });
});

describe('writing sections', () => {
  it('writes the title as a <summary> line, with &, < and > escaped', () => {
    expect(md(details(plain('a & <b>')), paragraph(plain('x')), detailsEnd())).toBe('<details>\n<summary>a &amp; &lt;b&gt;</summary>\n\nx\n\n</details>\n');
    expect(md(details(plain('T'), { open: true }), paragraph(plain('x')), detailsEnd())).toBe('<details open>\n<summary>T</summary>\n\nx\n\n</details>\n');
  });

  it('writes an empty section that reads back as one', () => {
    const text = md(details(plain('T')), detailsEnd());
    expect(text).toBe('<details>\n<summary>T</summary>\n\n</details>\n');
    expect(parse(text)).toEqual(['details:T', '/details']);
  });
});

describe('saving with the source', () => {
  const save = (doc: Doc, source: ReturnType<typeof loadMarkdown>['source']) => serializeMarkdown(doc, { source });

  it('keeps an unchanged section as written, and rewrites only an edited title', () => {
    const text = '<details OPEN>\n  <summary>T</summary>\n\nkeep *this*\n</details>\n\nafter\n';
    const { doc, source } = loadMarkdown(text);
    expect(save(doc, source)).toBe(text);
    const body = { blocks: doc.blocks.map((b, i) => (i === 1 ? withContent(b as never, plain('changed')) : b)) };
    expect(save(body, source)).toBe('<details OPEN>\n  <summary>T</summary>\n\nchanged\n\n</details>\n\nafter\n');
    const title = { blocks: doc.blocks.map((b, i) => (i === 0 ? withContent(b as never, plain('New')) : b)) };
    expect(save(title, source)).toBe('<details open>\n<summary>New</summary>\n\nkeep *this*\n</details>\n\nafter\n');
  });
});

describe('commands', () => {
  const state = (blocks: Block[], blockIndex = 0, offset = 0): EditorState => {
    const s = createState({ blocks });
    return { ...s, selection: caret(blocks[blockIndex]!.id, offset) };
  };
  const shown = (s: EditorState | null) => show(s!.doc.blocks);
  const at = (s: EditorState) => {
    const { blockId, offset } = s.selection.focus;
    return [s.doc.blocks.findIndex((b) => b.id === blockId), offset];
  };
  /** A section "T" with body "b", between paragraphs "x" and "y". */
  const section = () => [paragraph(plain('x')), details(plain('T')), paragraph(plain('b')), detailsEnd(), paragraph(plain('y'))];

  it('makes a section from an empty line, with the caret in the title', () => {
    const s = cmd.insertBlock(state([paragraph()]), { type: 'details' });
    expect(shown(s)).toEqual(['details:', 'p:', '/details']);
    expect(at(s)).toEqual([0, 0]);
  });

  it('makes a line with text the title, keeping it as plain text, with the caret in the body', () => {
    const p = paragraph([{ text: 'bold', marks: ['bold'] }]);
    const s = cmd.toggleBlockType(state([p], 0, 2), { type: 'details' });
    expect(shown(s)).toEqual(['details:bold', 'p:', '/details']);
    expect((s.doc.blocks[0] as unknown as { content: { marks: string[] }[] }).content[0]!.marks).toEqual([]);
    expect(at(s)).toEqual([1, 0]);
  });

  it('toggling a title removes the section and keeps its blocks', () => {
    const s = cmd.balanceSections(cmd.toggleBlockType(state(section(), 1, 1), { type: 'details' }));
    expect(shown(s)).toEqual(['p:x', 'p:T', 'p:b', 'p:y']);
  });

  it('typing ">>> " makes a section, unless details is off', () => {
    const typed = (dialect = {}) => cmd.applyBlockInputRules(state([paragraph(plain('>>> T'))], 0, 4), dialect);
    expect(shown(typed())).toEqual(['details:T', 'p:', '/details']);
    expect(typed({ details: false })).toBeNull();
  });

  it('Enter in a title starts the body with the text after the caret', () => {
    const s = cmd.splitBlock(state(section(), 1, 1));
    expect(shown(s)).toEqual(['p:x', 'details:T', 'p:', 'p:b', '/details', 'p:y']);
    expect(at(s)).toEqual([2, 0]);
    // At the end of the title, an empty first line takes the caret instead of a new one.
    const fresh = cmd.insertBlock(state([paragraph(plain('T'))], 0, 1), { type: 'details' });
    const enter = cmd.splitBlock({ ...fresh, selection: caret(fresh.doc.blocks[0]!.id, 1) });
    expect(shown(enter)).toEqual(['details:T', 'p:', '/details']);
    expect(at(enter)).toEqual([1, 0]);
  });

  it('Enter at the start of a title adds a line above the section', () => {
    const s = cmd.splitBlock(state(section(), 1, 0));
    expect(shown(s)).toEqual(['p:x', 'p:', 'details:T', 'p:b', '/details', 'p:y']);
  });

  it('Enter in a collapsed title adds the line after the section', () => {
    const s = cmd.splitCollapsedTitle(state(section(), 1, 1));
    expect(shown(s)).toEqual(['p:x', 'details:T', 'p:b', '/details', 'p:', 'p:y']);
    expect(at(s)).toEqual([4, 0]);
  });

  it('Enter on an empty last line of a section moves the line out', () => {
    const blocks = section();
    blocks.splice(3, 0, paragraph());
    const s = cmd.splitBlock(state(blocks, 3));
    expect(shown(s)).toEqual(['p:x', 'details:T', 'p:b', '/details', 'p:', 'p:y']);
    expect(at(s)).toEqual([4, 0]);
  });

  it('a title is one line: newlines become spaces and Shift+Enter does nothing', () => {
    const s = state(section(), 1, 1);
    expect(shown(cmd.insertText(s, 'a\nb'))[1]).toBe('details:Ta b');
    expect(cmd.insertLineBreak(s)).toBe(s);
  });

  it('Backspace after a section moves into its last line, and removes an empty line on the way', () => {
    const s = cmd.deleteBackward(state(section(), 4, 0));
    expect(shown(s)).toEqual(shown(state(section())));
    expect(at(s)).toEqual([2, 1]);
    const blocks = section();
    blocks[4] = paragraph();
    const empty = cmd.deleteBackward(state(blocks, 4, 0));
    expect(shown(empty)).toEqual(['p:x', 'details:T', 'p:b', '/details']);
    expect(at(empty)).toEqual([2, 1]);
  });

  it('Delete never pulls a title or an end into a line', () => {
    const before = state(section(), 0, 1);
    expect(cmd.deleteForward(before)).toBe(before);
    const last = state(section(), 2, 1);
    expect(cmd.deleteForward(last)).toBe(last);
    const blocks = section();
    blocks[0] = paragraph();
    expect(shown(cmd.deleteForward(state(blocks, 0)))).toEqual(['details:T', 'p:b', '/details', 'p:y']);
  });

  it('Backspace at the start of a title turns it into a line, and the section into its blocks', () => {
    const s = cmd.balanceSections(cmd.deleteBackward(state(section(), 1, 0)));
    expect(shown(s)).not.toContain('/details');
    expect(shown(s).filter((b) => b.startsWith('details'))).toEqual([]);
  });

  it('closeSections drops an end with no title and makes a title with no end a line', () => {
    const t = details(plain('T'));
    expect(show(cmd.closeSections([paragraph(plain('a')), detailsEnd()]))).toEqual(['p:a']);
    expect(show(cmd.closeSections([t, paragraph(plain('a'))]))).toEqual(['p:T', 'p:a']);
    const whole = section();
    expect(cmd.closeSections(whole)).toBe(whole);
  });

  it('balanceSections moves a caret off an end, to the text before it', () => {
    const s = cmd.balanceSections(state(section(), 3));
    expect(at(s)).toEqual([2, 1]);
  });

  it('sectionEnd finds the end of a nested section', () => {
    const blocks = [details(plain('A')), details(plain('B')), detailsEnd(), paragraph(), detailsEnd()];
    expect(cmd.sectionEnd(blocks, 0)).toBe(4);
    expect(cmd.sectionEnd(blocks, 1)).toBe(2);
  });
});

describe('clipboard', () => {
  const window = new Window();
  const parser = new window.DOMParser() as unknown as DOMParser;

  it('copies a section as <details> with a <summary>, and pastes it back', () => {
    const blocks = [details(plain('a & b'), { open: true }), paragraph(plain('x')), detailsEnd(), paragraph(plain('y'))];
    const html = docToHtml({ blocks });
    expect(html).toBe('<details open><summary>a &amp; b</summary><p>x</p></details><p>y</p>');
    expect(show(htmlToDoc(html, parser).blocks)).toEqual(['details+:a & b', 'p:x', '/details', 'p:y']);
  });

  it('pastes <details> from a web page, nested ones included', () => {
    const html = '<details><summary>Outer <b>bold</b></summary><p>x</p><details><summary>Inner</summary>y</details></details>';
    expect(show(htmlToDoc(html, parser).blocks)).toEqual(['details:Outer bold', 'p:x', 'details:Inner', 'p:y', '/details', '/details']);
  });
});
