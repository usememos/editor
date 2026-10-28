// The syntax tree as a public API: `parseAst`, the walker and the source
// positions, as a host that reads a document as data uses them.

import { describe, expect, it } from 'vitest';
import {
  type BlockQuoteNode,
  type ImageNode,
  type ListItemNode,
  type ParagraphNode,
  type TableNode,
  type TreeNode,
  footnotes,
  inlineNodesText,
  lineTable,
  nodeChildren,
  parseAst,
  parseMarkdown,
  sourceRange,
  visit,
} from '../src/index';

/** The lines of `text`, 1-based. */
const lines = (text: string) => text.split('\n');

describe('parseAst', () => {
  it('is exported, takes the editor options, and resolves references', () => {
    const root = parseAst('[a]: /u "t"\n\n[a] and [^1]\n\n[^1]: note', { syntax: [footnotes().markdown!] });
    const paragraph = root.children[0] as ParagraphNode;
    expect(paragraph.children[0]).toMatchObject({ type: 'link', destination: '/u', title: 't' });
    // The footnote reference is a token of the extension's syntax, and the definition a raw block of it.
    expect(paragraph.children[2]).toMatchObject({ type: 'token', name: 'footnote', value: '[^1]' });
    expect(root.children[1]).toMatchObject({ type: 'raw', name: 'footnote' });
    // Definitions stay source text, for byte-exact saves.
    expect(root.definitions).toEqual(['[a]: /u "t"']);
    // The same options give the same document the editor shows.
    expect(parseMarkdown('[a]: /u "t"\n\n[a]').blocks).toHaveLength(1);
  });
});

describe('tasks', () => {
  const DOC = ['> - [ ] one', '>   - [x] two', '>     - [ ] three', '> - [X] four', '>', '> text', '', '- [ ] five'].join('\n');

  const tasks = (text: string) => {
    const out: { checked: boolean; line: number; end: number }[] = [];
    visit(parseAst(text), (node) => {
      if (node.type === 'listItem' && node.task) out.push({ checked: node.checked, line: node.lines!.start, end: node.lines!.end });
    });
    return out;
  };

  it('finds every task at any depth with the line that holds its marker', () => {
    expect(tasks(DOC)).toEqual([
      { checked: false, line: 1, end: 3 },
      { checked: true, line: 2, end: 3 },
      { checked: false, line: 3, end: 3 },
      { checked: true, line: 4, end: 4 },
      { checked: false, line: 8, end: 8 },
    ]);
  });

  it('rewriting the marker on that line toggles exactly that task', () => {
    const toggle = (text: string, index: number) => {
      const task = tasks(text)[index]!;
      const all = lines(text);
      all[task.line - 1] = all[task.line - 1]!.replace(/\[([ xX])\]/, (_, m: string) => (m === ' ' ? '[x]' : '[ ]'));
      return all.join('\n');
    };
    const toggled = toggle(DOC, 2);
    expect(lines(toggled)[2]).toBe('>     - [x] three');
    expect(tasks(toggled).map((t) => t.checked)).toEqual([false, true, true, true, false]);
    expect(tasks(toggle(toggled, 1)).map((t) => t.checked)).toEqual([false, false, true, true, false]);
  });
});

describe('images', () => {
  const DOC = ['![inline](a.png "t")', '', '> - see ![ref][img] here', '', '<div>', '<img src="c.png">', '</div>', '', '[img]: b.png "b"'].join('\n');

  it('reads every destination from the tree, references resolved', () => {
    const root = parseAst(DOC);
    const images: ImageNode[] = [];
    visit(root, (node) => {
      if (node.type === 'image') images.push(node);
    });
    expect(images.map((i) => [i.destination, i.title, inlineNodesText(i.children, ' ')])).toEqual([
      ['a.png', 't', 'inline'],
      ['b.png', 'b', 'ref'],
    ]);
    // An image inside HTML is the HTML block's text; the host reads it as HTML.
    const html = root.children.find((n) => n.type === 'htmlBlock');
    expect(html).toMatchObject({ value: '<div>\n<img src="c.png">\n</div>' });
    expect(root.definitions).toEqual(['[img]: b.png "b"']);
  });

  it('maps an image back to where it was written, inside a quote and a list too', () => {
    const root = parseAst(DOC);
    const first = root.children[0] as ParagraphNode;
    const table = lineTable(DOC);
    const slice = (block: ParagraphNode, node: ImageNode) => {
      const r = sourceRange(table, block.source!, node.pos!);
      return DOC.slice(r.from, r.to);
    };
    expect(slice(first, first.children[0] as ImageNode)).toBe('![inline](a.png "t")');
    let quoted: ParagraphNode | undefined;
    visit(root, (node, ancestors) => {
      if (node.type === 'paragraph' && ancestors.some((a) => a.type === 'listItem')) quoted = node;
    });
    expect(slice(quoted!, quoted!.children[1] as ImageNode)).toBe('![ref][img]');
    // With the text instead of its line table.
    expect(sourceRange(DOC, first.source!, first.children[0]!.pos!)).toEqual({ from: 0, to: 20 });
  });

  it('maps a range that crosses lines and a table cell', () => {
    const text = '> a **b\n> c** d\n\n| x | **y** |\n| - | - |';
    const root = parseAst(text);
    const paragraph = (root.children[0] as BlockQuoteNode).children[0] as ParagraphNode;
    const strong = paragraph.children[1]!;
    const r = sourceRange(text, paragraph.source!, strong.pos!);
    expect(text.slice(r.from, r.to)).toBe('**b\n> c**');
    const table = root.children[1] as TableNode;
    const cell = table.rows[0]![1]!;
    const c = sourceRange(text, table.sources![0]![1]!, cell[0]!.pos!);
    expect(text.slice(c.from, c.to)).toBe('**y**');
  });
});

describe('excerpts', () => {
  it('gives the text of mixed blocks with soft breaks as given and hard breaks as newlines', () => {
    const root = parseAst('# Title\n\nFirst line\nsecond line  \nthird\n\n- item **bold** `code`\n\n| a | b |\n|---|---|\n| c | d |');
    const texts: string[] = [];
    visit(root, (node) => {
      if (node.type === 'paragraph' || node.type === 'heading') texts.push(inlineNodesText(node.children, ' '));
      if (node.type === 'table') texts.push(node.rows.map((row) => row.map((cell) => inlineNodesText(cell, ' ')).join(' | ')).join('\n'));
    });
    expect(texts).toEqual(['Title', 'First line second line\nthird', 'item bold code', 'a | b\nc | d']);
    // The `breaks` dialect reads a soft break as a line break: pass "\n".
    const breaks = parseAst('a\nb', { breaks: true }).children[0] as ParagraphNode;
    expect(inlineNodesText(breaks.children, '\n')).toBe('a\nb');
  });
});

describe('visit', () => {
  it('walks in document order, reaches table cells and image descriptions, and can skip children', () => {
    const root = parseAst('- a *b*\n\n| ![i *j*](k) |\n| - |');
    const order: string[] = [];
    visit(root, (node) => {
      order.push(node.type);
    });
    expect(order).toEqual(['root', 'list', 'listItem', 'paragraph', 'text', 'emphasis', 'text', 'table', 'image', 'text', 'emphasis', 'text']);
    const skipped: string[] = [];
    visit(root, (node) => {
      skipped.push(node.type);
      if (node.type === 'list') return false;
    });
    expect(skipped).toEqual(['root', 'list', 'table', 'image', 'text', 'emphasis', 'text']);
    // Ancestors are the path from the root; a subtree can be walked on its own.
    const depths: [string, number][] = [];
    visit(root.children[0]!, (node, ancestors) => {
      depths.push([node.type, ancestors.length]);
    });
    expect(depths).toEqual([['list', 0], ['listItem', 1], ['paragraph', 2], ['text', 3], ['emphasis', 3], ['text', 4]]);
    const table = root.children[1] as TreeNode;
    expect(nodeChildren(table).map((n) => n.type)).toEqual(['image']);
  });
});
