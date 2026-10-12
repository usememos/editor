// Source-preserving save: unchanged blocks are written exactly as loaded.

import { describe, expect, it } from 'vitest';
import { type Block, type Doc, paragraph, plain, withContent } from '../src/model';
import { loadMarkdown } from '../src/markdown/source';
import { serializeMarkdown } from '../src/markdown/serialize';
import { commonmark, gfm } from './fixtures/examples';

const save = (doc: Doc, source: ReturnType<typeof loadMarkdown>['source']) => serializeMarkdown(doc, { source });

/** Replaces the text of the block at `index`, as an edit would. */
function editBlock(doc: Doc, index: number, text: string): Doc {
  const blocks = doc.blocks.map((b, i) => (i === index && 'content' in b ? (withContent(b, plain(text)) as Block) : b));
  return { blocks };
}

describe('unchanged documents save byte for byte', () => {
  for (const ex of [...commonmark, ...gfm]) {
    const name = `${ex.extension ? 'GFM ' + ex.extension : 'CommonMark'} example ${ex.example} (${ex.section})`;
    it(name, () => {
      const { doc, source } = loadMarkdown(ex.markdown);
      expect(save(doc, source)).toBe(ex.markdown);
    });
  }

  const samples: Record<string, string> = {
    'no final newline': 'line one\nline two',
    'CRLF line endings': 'a\r\nb\r\n\r\n- c\r\n- d\r\n',
    'several blank lines': 'a\n\n\n\nb',
    'blank lines at both ends': '\n\n# h\n\n\n',
    'star bullets and loose lists': '* a\n\n* b\n',
    'setext heading': 'Title\n===\n\ntext',
    'block math': '$$\n\\int_0^1 x\\,dx\n$$',
    'footnote': 'Text[^1].\n\n[^1]: The note.',
    'list inside a quote': '> - a\n> - b',
    'reference link': '[x][1]\n\n[1]: https://a.com',
    'table after a paragraph': 'intro\n| a | b |\n| - | - |\n| 1 | 2 |',
    'unclosed fence': 'text\n\n```js\nlet a',
  };
  for (const [name, md] of Object.entries(samples)) {
    it(name, () => {
      const { doc, source } = loadMarkdown(md);
      expect(save(doc, source)).toBe(md);
    });
  }
});

describe('edited documents', () => {
  it('rewrites only the edited block', () => {
    const md = '* one\n* two\n\nfirst  para\nsecond line\n\n\n__bold__ stays\n';
    const { doc, source } = loadMarkdown(md);
    expect(save(editBlock(doc, 2, 'new'), source)).toBe('* one\n* two\n\nnew\n\n\n__bold__ stays\n');
  });

  it('rewrites a whole list when one item changes', () => {
    const { doc, source } = loadMarkdown('para\n\n* a\n* b\n\nend');
    expect(save(editBlock(doc, 2, 'B'), source)).toBe('para\n\n- a\n- B\n\nend');
  });

  it('keeps the original text between groups that are still neighbours', () => {
    const { doc, source } = loadMarkdown('a\n\n\n\nb\n\nc');
    const removed: Doc = { blocks: [doc.blocks[0]!, doc.blocks[1]!] };
    expect(save(removed, source)).toBe('a\n\n\n\nb');
    const middle: Doc = { blocks: [doc.blocks[0]!, doc.blocks[2]!] };
    expect(save(middle, source)).toBe('a\n\nc');
  });

  it('writes new blocks normally between kept ones', () => {
    const { doc, source } = loadMarkdown('a\n\n\nb');
    const inserted: Doc = { blocks: [doc.blocks[0]!, paragraph(plain('*new*')), doc.blocks[1]!] };
    expect(save(inserted, source)).toBe('a\n\n\\*new\\*\n\nb');
  });

  it('does not let a kept list merge with a new list item', () => {
    const { doc, source } = loadMarkdown('* a\n* b');
    const added = loadMarkdown('- c').doc.blocks[0]!;
    expect(save({ blocks: [...doc.blocks, added] }, source)).toBe('- a\n- b\n- c');
  });

  it('does not let an unclosed fence swallow a new block', () => {
    const { doc, source } = loadMarkdown('```\ncode');
    expect(save({ blocks: [...doc.blocks, paragraph(plain('after'))] }, source)).toBe('```\ncode\n```\n\nafter');
  });

  it('writes two kept lists as one list when the block between them is deleted', () => {
    const { doc, source } = loadMarkdown('* a\n* b\n\npara\n\n* c\n');
    const removed: Doc = { blocks: [doc.blocks[0]!, doc.blocks[1]!, doc.blocks[3]!] };
    // Kept as written, the two lists would read back as one loose list.
    expect(save(removed, source)).toBe('- a\n- b\n- c\n');
  });

  it('keeps two kept groups byte for byte when they cannot merge', () => {
    const { doc, source } = loadMarkdown('# Title\n\nmiddle\n\n* a\n* b\n');
    const removed: Doc = { blocks: [doc.blocks[0]!, doc.blocks[2]!, doc.blocks[3]!] };
    expect(save(removed, source)).toBe('# Title\n\n* a\n* b\n');
  });

  it('does not let an indented paragraph join a list it now follows', () => {
    const { doc, source } = loadMarkdown('- a\n\npara\n\n   indented\n');
    const removed: Doc = { blocks: [doc.blocks[0]!, doc.blocks[2]!] };
    const out = save(removed, source);
    expect(out).toBe('- a\n\nindented\n');
    expect(loadMarkdown(out).doc.blocks.map((b) => b.type)).toEqual(['listItem', 'paragraph']);
  });

  it('does not let an indented code block join a list it now follows', () => {
    const { doc, source } = loadMarkdown('- a\n\npara\n\n    code\n');
    const removed: Doc = { blocks: [doc.blocks[0]!, doc.blocks[2]!] };
    expect(save(removed, source)).toBe('- a\n\n```\ncode\n```\n');
  });

  it('drops empty paragraphs added at the end', () => {
    const { doc, source } = loadMarkdown('a');
    expect(save({ blocks: [...doc.blocks, paragraph(), paragraph()] }, source)).toBe('a');
  });

  it('keeps reference definitions that kept blocks still use', () => {
    const md = '[x][1]\n\n[1]: https://a.com\nedited';
    const { doc, source } = loadMarkdown(md);
    expect(doc.blocks.length).toBe(2);
    expect(save(editBlock(doc, 1, 'changed'), source)).toBe('[x][1]\n\nchanged\n\n[1]: https://a.com');
  });

  it('writes an empty document as an empty string', () => {
    const { source } = loadMarkdown('a\n');
    expect(save({ blocks: [paragraph()] }, source)).toBe('');
  });
});
