// Image size and alignment: `![alt|center|320](src)` in Markdown, `<img width>`
// and `text-align` on the clipboard, and image blocks.

import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { docToHtml } from '../src/clipboard/toHtml';
import { htmlToDoc } from '../src/clipboard/fromHtml';
import { ATOM_CHAR, type ImageAtom, type Inline, createState, imageBlockOffset, isImageBlock, paragraph, plain, table } from '../src/model';
import * as commands from '../src/commands';
import { parseInline, parseMarkdown, serializeInline, serializeMarkdown } from '../src/index';
import { renderAstToHtml } from '../src/markdown/html';
import { parseAst } from '../src/markdown/blocks';

const image = (markdown: string): ImageAtom | undefined => parseInline(markdown).find((s) => s.image)?.image;
const img = (image: ImageAtom): Inline => [{ text: ATOM_CHAR, marks: [], image }];

describe('image size in Markdown', () => {
  it('reads a width after the alt text', () => {
    expect(image('![chart|320](a.png)')).toEqual({ src: 'a.png', alt: 'chart', width: 320 });
    expect(image('![|320](a.png)')).toEqual({ src: 'a.png', alt: '', width: 320 });
    expect(image('![chart|320](a.png "Sales")')).toEqual({ src: 'a.png', alt: 'chart', title: 'Sales', width: 320 });
  });

  it('reads a width and a height', () => {
    expect(image('![chart|320x200](a.png)')).toEqual({ src: 'a.png', alt: 'chart', width: 320, height: 200 });
  });

  it('keeps alt text that only looks like a size', () => {
    expect(image('![a|b](a.png)')).toEqual({ src: 'a.png', alt: 'a|b' });
    expect(image('![a|0](a.png)')).toEqual({ src: 'a.png', alt: 'a|0' });
    expect(image('![a|320px](a.png)')).toEqual({ src: 'a.png', alt: 'a|320px' });
    expect(image('![a|123456](a.png)')).toEqual({ src: 'a.png', alt: 'a|123456' });
    expect(image('![a | 320](a.png)')).toEqual({ src: 'a.png', alt: 'a | 320' });
  });

  it('does not read an escaped pipe or a character reference as a size', () => {
    expect(image('![a\\|320](a.png)')).toEqual({ src: 'a.png', alt: 'a|320' });
    expect(image('![a&#124;320](a.png)')).toEqual({ src: 'a.png', alt: 'a|320' });
    // An escaped backslash before the pipe leaves the pipe unescaped.
    expect(image('![a\\\\|320](a.png)')).toEqual({ src: 'a.png', alt: 'a\\', width: 320 });
  });

  it('keeps only the last size', () => {
    expect(image('![a|5|320](a.png)')).toEqual({ src: 'a.png', alt: 'a|5', width: 320 });
  });

  it('reads a size on a reference image', () => {
    expect(parseMarkdown('![chart|320][x]\n\n[x]: a.png').blocks[0]).toMatchObject({
      content: [{ image: { src: 'a.png', alt: 'chart', width: 320 } }],
    });
  });

  it('reads a size in a table cell, where the pipe is escaped', () => {
    const doc = parseMarkdown('| a |\n| - |\n| ![chart\\|320](a.png) |');
    const block = doc.blocks[0]!;
    expect(block.type === 'table' && block.rows[1]![0]![0]!.image).toEqual({ src: 'a.png', alt: 'chart', width: 320 });
  });

  it('writes the size after the alt text', () => {
    expect(serializeInline(img({ src: 'a.png', alt: 'chart', width: 320 }))).toBe('![chart|320](a.png)');
    expect(serializeInline(img({ src: 'a.png', alt: 'chart', width: 320, height: 200 }))).toBe('![chart|320x200](a.png)');
    expect(serializeInline(img({ src: 'a.png', alt: '', title: 'Sales', width: 320 }))).toBe('![|320](a.png "Sales")');
  });

  it('writes alt text that ends like a size so it reads back as text', () => {
    const md = serializeInline(img({ src: 'a.png', alt: 'sales|2024' }));
    expect(md).toBe('![sales&#124;2024](a.png)');
    expect(image(md)).toEqual({ src: 'a.png', alt: 'sales|2024' });
    expect(serializeInline(img({ src: 'a.png', alt: 'a|b' }))).toBe('![a|b](a.png)');
  });

  it('round-trips sizes in paragraphs and table cells', () => {
    const images: ImageAtom[] = [
      { src: 'a.png', alt: 'chart', width: 320 },
      { src: 'a.png', alt: 'chart', width: 320, height: 200 },
      { src: 'a.png', alt: 'a|5', width: 7 },
      { src: 'a.png', alt: 'a|5' },
      { src: 'a.png', alt: 'a\\', width: 320 },
      { src: 'a.png', alt: 'x|1x2' },
    ];
    for (const atom of images) {
      const doc = { blocks: [paragraph(img(atom)), table([null], [[[{ text: 'h', marks: [] }]], [img(atom)]])] };
      const back = parseMarkdown(serializeMarkdown(doc)).blocks;
      expect(back[0]).toMatchObject({ content: [{ image: atom }] });
      expect(back[1]!.type === 'table' && back[1]!.rows[1]![0]![0]!.image).toEqual(atom);
    }
  });

  it('leaves the CommonMark HTML unchanged', () => {
    expect(renderAstToHtml(parseAst('![chart|320](a.png)'))).toBe('<p><img src="a.png" alt="chart|320" /></p>\n');
  });
});

describe('image size on the clipboard', () => {
  const window = new Window();
  const parser = new window.DOMParser() as unknown as DOMParser;

  it('copies the size as width and height attributes', () => {
    const doc = { blocks: [paragraph(img({ src: 'a.png', alt: 'chart', width: 320, height: 200 }))] };
    expect(docToHtml(doc)).toContain('<img src="a.png" alt="chart" width="320" height="200">');
  });

  it('pastes a width in pixels', () => {
    const pasted = (html: string) => htmlToDoc(html, parser).blocks[0];
    expect(pasted('<img src="a.png" alt="chart" width="320">')).toMatchObject({ content: [{ image: { src: 'a.png', alt: 'chart', width: 320 } }] });
    expect(pasted('<img src="a.png" alt="" width="320" height="200">')).toMatchObject({ content: [{ image: { width: 320, height: 200 } }] });
    expect(pasted('<img src="a.png" alt="" width="50%">')).toMatchObject({ content: [{ image: { src: 'a.png', alt: '' } }] });
    expect((pasted('<img src="a.png" alt="" width="50%">') as { content: Inline }).content[0]!.image!.width).toBeUndefined();
  });
});

describe('image commands', () => {
  const at = (doc: ReturnType<typeof parseMarkdown>, offset: number) => ({ blockId: doc.blocks[0]!.id, offset });
  const state = (markdown: string, offset = 2) => {
    const doc = parseMarkdown(markdown);
    return { ...createState(doc), selection: { anchor: at(doc, offset), focus: at(doc, offset + 1) } };
  };
  const saved = (s: { doc: ReturnType<typeof parseMarkdown> }) => serializeMarkdown(s.doc);

  it('finds the image the selection covers exactly', () => {
    expect(commands.selectedImage(state('a ![x](u) b'))).toMatchObject({ pos: { offset: 2 }, image: { src: 'u', alt: 'x' } });
    expect(commands.selectedImage(state('a ![x](u) b', 1))).toBeNull();
    const s = state('a ![x](u) b');
    expect(commands.selectedImage({ ...s, selection: { anchor: s.selection.focus, focus: s.selection.anchor } })).not.toBeNull();
  });

  it('selects an image by its position, and only an image', () => {
    const s = state('a ![x](u) b', 0);
    const pos = { ...s.selection.anchor, offset: 2 };
    expect(commands.selectImage(s, pos).selection).toEqual({ anchor: pos, focus: { ...pos, offset: 3 } });
    expect(commands.selectImage(s, { ...pos, offset: 1 })).toBe(s);
  });

  it('changes the width and drops the height', () => {
    const s = state('a ![x|10x20](u) b');
    const pos = s.selection.anchor;
    expect(saved(commands.updateImage(s, pos, { width: 99.6 }))).toBe('a ![x|100](u) b\n');
    expect(saved(commands.updateImage(s, pos, { width: null }))).toBe('a ![x](u) b\n');
    expect(saved(commands.updateImage(s, pos, { width: 10 }))).toBe('a ![x|10x20](u) b\n');
    expect(saved(commands.updateImage(s, pos, { width: 0 }))).toBe('a ![x|1](u) b\n');
  });

  it('changes the alt text and the title, and keeps the image selected', () => {
    const s = state('a ![x|10](u "t") b');
    const pos = s.selection.anchor;
    const next = commands.updateImage(s, pos, { alt: 'New', title: null });
    expect(saved(next)).toBe('a ![New|10](u) b\n');
    expect(commands.selectedImage(next)?.image).toEqual({ src: 'u', alt: 'New', width: 10 });
    expect(commands.updateImage(s, { ...pos, offset: 0 }, { alt: 'y' })).toBe(s);
  });
});

describe('image alignment in Markdown', () => {
  it('reads an alignment, alone or before the size', () => {
    expect(image('![chart|center](a.png)')).toEqual({ src: 'a.png', alt: 'chart', align: 'center' });
    expect(image('![chart|right|320](a.png)')).toEqual({ src: 'a.png', alt: 'chart', align: 'right', width: 320 });
    expect(image('![chart|left|320x200](a.png)')).toEqual({ src: 'a.png', alt: 'chart', align: 'left', width: 320, height: 200 });
    expect(image('![|center](a.png "T")')).toEqual({ src: 'a.png', alt: '', title: 'T', align: 'center' });
  });

  it('keeps alt text that only looks like an alignment', () => {
    expect(image('![a|Center](a.png)')).toEqual({ src: 'a.png', alt: 'a|Center' });
    expect(image('![a|middle](a.png)')).toEqual({ src: 'a.png', alt: 'a|middle' });
    expect(image('![a|320|center](a.png)')).toEqual({ src: 'a.png', alt: 'a|320', align: 'center' });
    expect(image('![a\\|center](a.png)')).toEqual({ src: 'a.png', alt: 'a|center' });
    expect(image('![a&#124;center](a.png)')).toEqual({ src: 'a.png', alt: 'a|center' });
  });

  it('reads only the size when the alignment\'s pipe is escaped', () => {
    expect(image('![a\\|center|320](a.png)')).toEqual({ src: 'a.png', alt: 'a|center', width: 320 });
  });

  it('reads an alignment in a table cell', () => {
    const block = parseMarkdown('| a |\n| - |\n| ![chart\\|center\\|320](a.png) |').blocks[0]!;
    expect(block.type === 'table' && block.rows[1]![0]![0]!.image).toEqual({ src: 'a.png', alt: 'chart', align: 'center', width: 320 });
  });

  it('writes the alignment before the size, and keeps a written left', () => {
    expect(serializeInline(img({ src: 'a.png', alt: 'chart', align: 'center' }))).toBe('![chart|center](a.png)');
    expect(serializeInline(img({ src: 'a.png', alt: 'chart', align: 'right', width: 320 }))).toBe('![chart|right|320](a.png)');
    expect(serializeInline(img({ src: 'a.png', alt: 'chart', align: 'left' }))).toBe('![chart|left](a.png)');
  });

  it('writes alt text that ends like an alignment so it reads back as text', () => {
    for (const atom of [
      { src: 'a.png', alt: 'a|center' },
      { src: 'a.png', alt: 'a|center', width: 320 },
      { src: 'a.png', alt: 'a|right|5' },
      { src: 'a.png', alt: 'a|320', align: 'center' as const },
      { src: 'a.png', alt: 'a|center', align: 'right' as const, width: 2 },
    ]) {
      expect(image(serializeInline(img(atom)))).toEqual(atom);
    }
    expect(serializeInline(img({ src: 'a.png', alt: 'a|center' }))).toBe('![a&#124;center](a.png)');
    // Alt text that already reads back correctly is not escaped.
    expect(serializeInline(img({ src: 'a.png', alt: 'a|5', width: 7 }))).toBe('![a|5|7](a.png)');
    expect(serializeInline(img({ src: 'a.png', alt: 'a|center', align: 'right' }))).toBe('![a|center|right](a.png)');
  });

  it('round-trips documents with alignments unchanged', () => {
    for (const md of ['![a|center](x)\n', '![a|left|320](x)\n', 'text ![a|right](x) text\n', '- ![a|center|20x10](x)\n']) {
      expect(serializeMarkdown(parseMarkdown(md))).toBe(md);
    }
  });

  it('leaves the CommonMark HTML unchanged', () => {
    expect(renderAstToHtml(parseAst('![chart|center|320](a.png)'))).toBe('<p><img src="a.png" alt="chart|center|320" /></p>\n');
  });
});

describe('image blocks', () => {
  const first = (markdown: string) => parseMarkdown(markdown).blocks[0]!;

  it('is a paragraph that holds only one image', () => {
    expect(isImageBlock(first('![a](x)'))).toBe(true);
    expect(isImageBlock(first('![a|center|20](x "t")'))).toBe(true);
    expect(imageBlockOffset(paragraph([...plain('  '), ...img({ src: 'x', alt: '' }), ...plain(' ')]))).toBe(2);
  });

  it('is not an image beside text, two images, a linked or formatted image, or an image in another block', () => {
    for (const md of ['a ![a](x)', '![a](x) ![b](y)', '![a](x)\n![b](y)', '[![a](x)](http://a)', '*![a](x)*', '- ![a](x)', '> ![a](x)', '# ![a](x)']) {
      expect(isImageBlock(first(md)), md).toBe(false);
    }
  });

  const at = (doc: ReturnType<typeof parseMarkdown>, index: number, offset: number) => ({ blockId: doc.blocks[index]!.id, offset });
  const select = (markdown: string, anchor: [number, number], focus = anchor) => {
    const doc = parseMarkdown(markdown);
    return { ...createState(doc), selection: { anchor: at(doc, ...anchor), focus: at(doc, ...focus) } };
  };
  const saved = (s: { doc: ReturnType<typeof parseMarkdown> }) => serializeMarkdown(s.doc);

  it('finds a selected image block, and only an image block', () => {
    expect(commands.selectedImageBlock(select('![a](x)', [0, 0], [0, 1]))).toMatchObject({ pos: { offset: 0 } });
    expect(commands.selectedImageBlock(select('a ![a](x)', [0, 2], [0, 3]))).toBeNull();
  });

  it('sets and removes the alignment in one change', () => {
    const s = select('![a|20](x)', [0, 0], [0, 1]);
    const centered = commands.updateImage(s, s.selection.anchor, { align: 'center' });
    expect(saved(centered)).toBe('![a|center|20](x)\n');
    expect(saved(commands.updateImage(centered, s.selection.anchor, { align: null }))).toBe('![a|20](x)\n');
    expect(saved(commands.updateImage(centered, s.selection.anchor, { width: null }))).toBe('![a|center](x)\n');
    expect(commands.updateImage(centered, s.selection.anchor, { align: 'center' }).doc).toBe(centered.doc);
  });

  it('deletes a selected image block as a whole block', () => {
    const back = commands.deleteBackward(select('a\n\n![b](x)\n\nc', [1, 0], [1, 1]));
    expect(saved(back)).toBe('a\n\nc\n');
    expect(back.selection.focus).toMatchObject({ offset: 1 });
    const forward = commands.deleteForward(select('a\n\n![b](x)\n\nc', [1, 1], [1, 0]));
    expect(saved(forward)).toBe('a\n\nc\n');
    expect(forward.selection.focus).toMatchObject({ blockId: forward.doc.blocks[1]!.id, offset: 0 });
    // An inline image is deleted as a character.
    expect(saved(commands.deleteBackward(select('a ![b](x) c', [0, 2], [0, 3])))).toBe('a  c\n');
  });

  it('selects an image block before Backspace or Delete would join it to the next block', () => {
    const back = commands.deleteBackward(select('![b](x)\n\nc', [1, 0]));
    expect(saved(back)).toBe('![b](x)\n\nc\n');
    expect(commands.selectedImageBlock(back)).not.toBeNull();
    const forward = commands.deleteForward(select('a\n\n![b](x)', [0, 1]));
    expect(saved(forward)).toBe('a\n\n![b](x)\n');
    expect(commands.selectedImageBlock(forward)).not.toBeNull();
  });

  it('removes an empty paragraph on the way to an image block', () => {
    const back = commands.deleteBackward(select('![b](x)\n\n\u00a0', [1, 0]));
    expect(back.doc.blocks).toHaveLength(1);
    expect(commands.selectedImageBlock(back)).not.toBeNull();
  });

  it('adds a paragraph past a selected final image block', () => {
    const s = select('a\n\n![b](x)', [1, 0], [1, 1]);
    const next = commands.exitBlock(s, 1);
    expect(next.doc.blocks).toHaveLength(3);
    expect(next.selection.focus.blockId).toBe(next.doc.blocks[2]!.id);
    expect(commands.exitBlock(select('![b](x)\n\na', [0, 0], [0, 1]), 1)).toMatchObject({ doc: { blocks: { length: 2 } } });
  });
});

describe('image alignment on the clipboard', () => {
  it('copies an image block\'s alignment as text-align', () => {
    expect(docToHtml(parseMarkdown('![a|center](x)'))).toContain('<p style="text-align:center"><img src="x" alt="a">');
    expect(docToHtml(parseMarkdown('t ![a|center](x)'))).toContain('<p>t <img');
  });
});
