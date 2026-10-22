// Footnotes: a definition's text renders as Markdown, and read-only the
// referenced definitions are collected at the end, as on GitHub.

import { Window } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Editor, footnotes } from '../src/index';

describe('footnotes', () => {
  const window = new Window();
  const saved: Record<string, unknown> = {};
  beforeAll(() => {
    for (const key of ['document', 'window', 'HTMLElement', 'HTMLImageElement', 'HTMLInputElement', 'Node', 'Range'] as const) {
      saved[key] = (globalThis as Record<string, unknown>)[key];
      (globalThis as Record<string, unknown>)[key] = key === 'window' ? window : (window as unknown as Record<string, unknown>)[key];
    }
  });
  afterAll(() => Object.assign(globalThis, saved));

  const create = (content: string, editable: boolean) => {
    const element = window.document.createElement('div');
    window.document.body.appendChild(element);
    return new Editor({ element: element as unknown as HTMLElement, content, editable, extensions: [footnotes()] });
  };
  const doc = 'Fact[^1] and more[^note], again[^1].\n\n[^1]: The source, see [site](https://example.org),\n  with a second line.\n\n[^note]: Another.\n\n[^lost]: Nobody.\n';
  const labels = (notes: Iterable<Element>) => Array.from(notes).map((n) => (n as HTMLElement).dataset.label);
  const texts = (els: Iterable<Element>) => Array.from(els).map((el) => el.textContent);

  it('renders a definition where it is written, its text as Markdown, while editing', () => {
    const root = create(doc, true).root;
    const notes = root.querySelectorAll('.mbe-footnote');
    expect(labels(notes)).toEqual(['1', 'note', 'lost']);
    expect(notes[0]!.textContent).toBe('1The source, see site, with a second line.');
    expect(notes[0]!.querySelector('a')!.getAttribute('href')).toBe('https://example.org');
    expect(root.querySelector('.mbe-footnotes')).toBeNull();
    expect(root.querySelectorAll('.mbe-footnote-collected').length).toBe(0);
    expect(root.querySelectorAll('.mbe-footnote-ref').length).toBe(3);
  });

  it('collects the referenced definitions at the end when read-only, with a backlink per reference', () => {
    const editor = create(doc, false);
    const root = editor.root;
    const section = root.querySelector('.mbe-footnotes')!;
    expect(section).not.toBeNull();
    expect(section).toBe(root.lastElementChild);
    expect(section.getAttribute('aria-label')).toBe('Footnotes');
    // In order of first reference; the definition nothing references is left out.
    const notes = section.querySelectorAll('.mbe-footnote');
    expect(labels(notes)).toEqual(['1', 'note']);
    expect(notes[0]!.querySelector('a')!.getAttribute('href')).toBe('https://example.org');
    const backs = Array.from(notes[0]!.querySelectorAll<HTMLElement>('.mbe-footnote-backref'));
    expect(backs.map((b) => [b.dataset.label, b.dataset.ref, b.getAttribute('aria-label')])).toEqual([
      ['1', '1', 'Back to reference 1'],
      ['1', '2', 'Back to reference 1 2'],
    ]);
    expect(notes[1]!.querySelectorAll('.mbe-footnote-backref').length).toBe(1);
    // The definitions where they are written hide; the Markdown is unchanged.
    expect(labels(root.querySelectorAll(':scope > .mbe-footnote-collected'))).toEqual(['1', 'note', 'lost']);
    expect(editor.getMarkdown()).toBe(doc);
    // Editable again: the section goes and the definitions show where they are.
    editor.setOptions({ editable: true });
    expect(root.querySelector('.mbe-footnotes')).toBeNull();
    expect(root.querySelectorAll('.mbe-footnote-collected').length).toBe(0);
    editor.setOptions({ editable: false });
    expect(root.querySelector('.mbe-footnotes')).toBe(root.lastElementChild);
  });

  it('renders a note of several paragraphs and a code block, the backlink in the last paragraph', () => {
    const md = 'Fact[^1].\n\n[^1]: First paragraph.\n\n    Second paragraph.\n\n        code\n\nAfter.\n';
    const editing = create(md, true);
    const note = editing.root.querySelector('.mbe-footnote')!;
    expect(texts(note.querySelectorAll('p'))).toEqual(['First paragraph.', 'Second paragraph.']);
    expect(note.querySelector('pre code')!.textContent).toContain('code');
    // The memo's own paragraphs are untouched, and the Markdown is kept.
    expect(texts(editing.root.querySelectorAll(':scope > p'))).toEqual(['Fact1.', 'After.']);
    expect(editing.getMarkdown()).toBe(md);
    const reading = create(md, false).root;
    const items = reading.querySelectorAll('.mbe-footnotes .mbe-footnote');
    expect(items.length).toBe(1);
    // The code block is last, so the backlink gets a paragraph of its own after it.
    const paragraphs = items[0]!.querySelectorAll('p');
    expect(texts(paragraphs)).toEqual(['First paragraph.', 'Second paragraph.', '']);
    expect(paragraphs[2]!.querySelector('.mbe-footnote-backref')).not.toBeNull();
    expect(items[0]!.querySelector('pre code')!.textContent).toContain('code');
  });

  it('shows no section without a referenced definition', () => {
    expect(create('Text[^1] only.\n', false).root.querySelector('.mbe-footnotes')).toBeNull();
    const root = create('[^1]: Nobody.\n', false).root;
    expect(root.querySelector('.mbe-footnotes')).toBeNull();
    expect(root.querySelectorAll('.mbe-footnote-collected').length).toBe(1);
  });
});
