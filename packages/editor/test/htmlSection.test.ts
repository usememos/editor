import { describe, expect, test } from 'vitest';
import { footnotes } from '../src/extensions/footnotes';
import { splitHtmlSection, slotMarker } from '../src/markdown/htmlSection';

const types = (source: string) => splitHtmlSection(source)?.slots.map((slot) => slot.map((b) => b.type));

describe('splitHtmlSection', () => {
  test('keeps the HTML and puts a marker where each run of Markdown blocks was', () => {
    const section = splitHtmlSection('<details>\n<summary>S</summary>\n\n> quote\n\n```\ncode\n```\n\n</details>')!;
    expect(section.html).toBe(`<details>\n<summary>S</summary>\n\n${slotMarker(0)}\n\n</details>`);
    expect(section.slots.map((slot) => slot.map((b) => b.type))).toEqual([['quote', 'code']]);
  });

  test('gives each run between HTML blocks its own slot', () => {
    const section = splitHtmlSection('<div>\n\n# A\n\n<hr>\n\n- b\n- c\n\n</div>')!;
    expect(section.html).toBe(`<div>\n\n${slotMarker(0)}\n\n<hr>\n\n${slotMarker(1)}\n\n</div>`);
    expect(section.slots.map((slot) => slot.map((b) => b.type))).toEqual([['heading'], ['listItem', 'listItem']]);
  });

  test('keeps nested sections as HTML, so the browser nests them', () => {
    expect(types('<div>\n<details>\n<summary>S</summary>\n\nx\n\n</details>\n\ny\n\n</div>')).toEqual([['paragraph'], ['paragraph']]);
  });

  test('is null for HTML with no Markdown blocks', () => {
    expect(splitHtmlSection('<div>\n<p>hi</p>\n</div>')).toBeNull();
    expect(splitHtmlSection('<details><summary>S</summary>Body</details>')).toBeNull();
  });

  test('reads the Markdown with the document options and syntax', () => {
    const syntax = [footnotes().markdown!];
    const section = splitHtmlSection('<div>\n\nText[^1]\nnext\n\n[^1]: note\n\n</div>', { breaks: true, syntax })!;
    const [paragraph, definition] = section.slots[0]!;
    expect(paragraph).toMatchObject({ type: 'paragraph' });
    expect(paragraph!.type === 'paragraph' && paragraph!.content.map((s) => [s.text, s.token])).toEqual([
      ['Text', undefined],
      ['[^1]', 'footnote'],
      ['\nnext', undefined],
    ]);
    expect(definition).toMatchObject({ type: 'raw', syntax: 'footnote' });
  });
});
