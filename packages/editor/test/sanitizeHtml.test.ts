// @vitest-environment happy-dom
//
// Raw HTML renders only through `sanitizeHtml`: the editor parses an HTML
// block or an inline run with the browser's parser and the host's hook
// decides what of the tree reaches the page.

import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type EditorOptions, type SanitizeHtml, type SanitizeHtmlContext } from '../src/index';

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.root.remove();
    editor.destroy();
  }
});

const create = (content: string, options: Partial<EditorOptions> = {}) => {
  const element = document.createElement('div');
  document.body.appendChild(element);
  // <details> as an HTML section, not a collapsible section of blocks, so the sanitizer renders it.
  const editor = new Editor({ element, content, editable: false, markdown: { details: false }, ...options });
  editors.push(editor);
  return editor;
};

const allowAll: SanitizeHtml = (tree) => tree;

const SECTION = '<details><summary>x</summary>\n\n**bold**\n\n</details>';

describe('sanitizeHtml', () => {
  it('shows HTML as its source without a sanitizer, and ignores an extension view named html', () => {
    for (const extensions of [[], [{ name: 'old', views: { html: (source: string, el: HTMLElement) => void (el.innerHTML = source) } } as never]]) {
      const root = create(`${SECTION}\n\nPress <kbd>Ctrl</kbd>`, { extensions }).root;
      expect(root.querySelector('details')).toBeNull();
      expect(root.querySelector('kbd')).toBeNull();
      expect(root.querySelector('pre[data-syntax="html"]')?.textContent).toBe(SECTION);
      expect(Array.from(root.querySelectorAll('.mbe-raw-html'), (el) => el.textContent)).toEqual(['<kbd>', '</kbd>']);
    }
  });

  it('hands the sanitizer a parsed tree with the editor, never a string', () => {
    const seen: { tree: unknown; kind: string; editor: unknown; html: string }[] = [];
    const editor = create(`${SECTION}\n\nPress <kbd>Ctrl</kbd>`, {
      sanitizeHtml: (tree, ctx: SanitizeHtmlContext) => {
        const holder = document.createElement('div');
        holder.append(tree.cloneNode(true));
        seen.push({ tree, kind: ctx.kind, editor: ctx.editor, html: holder.innerHTML });
        return tree;
      },
    });
    expect(seen.map((s) => s.tree instanceof DocumentFragment)).toEqual([true, true]);
    expect(seen.map((s) => s.editor === editor)).toEqual([true, true]);
    expect(seen.map((s) => [s.kind, s.html])).toEqual([
      // The Markdown between the tags is a marker: the editor renders it itself.
      ['block', '<details><summary>x</summary>\n\n0\n\n</details>'],
      ['inline', '<kbd>0</kbd>'],
    ]);
  });

  it('renders a section across blank lines as one element with the Markdown rendered inside it', () => {
    const editor = create(SECTION, { sanitizeHtml: allowAll });
    const root = editor.root;
    const details = root.querySelectorAll('.mbe-view-html > details');
    expect(details.length).toBe(1);
    expect(details[0]!.querySelector('summary')?.textContent).toBe('x');
    expect(details[0]!.querySelector('.mbe-flow > p > strong')?.textContent).toBe('bold');
    expect(root.textContent).not.toContain('<');
    // Nothing inside is a block of the document, and the Markdown is saved as written.
    expect(details[0]!.querySelector('[data-block-id], [contenteditable]')).toBeNull();
    expect(editor.getMarkdown()).toBe(SECTION);
  });

  it('shows the source when the sanitizer returns nothing', () => {
    const root = create(`${SECTION}\n\nPress <kbd>Ctrl</kbd>`, { sanitizeHtml: () => null }).root;
    expect(root.querySelector('details')).toBeNull();
    expect(root.querySelector('pre[data-syntax="html"]')?.textContent).toBe(SECTION);
    expect(Array.from(root.querySelectorAll('.mbe-raw-html'), (el) => el.textContent)).toEqual(['<kbd>', '</kbd>']);
  });

  it('keeps the Markdown of a slot whose element the sanitizer removed, after the rest', () => {
    const strict: SanitizeHtml = (tree) => {
      for (const el of Array.from(tree.querySelectorAll('details, script'))) el.remove();
      return tree;
    };
    // The script is an HTML block of its own; the section follows it.
    const root = create(`<script>alert(1)</script>\n\n${SECTION}`, { sanitizeHtml: strict }).root;
    expect(root.querySelector('details, script')).toBeNull();
    const views = root.querySelectorAll('.mbe-view-html');
    expect(views.length).toBe(2);
    expect(views[0]!.textContent).toBe('');
    expect(views[1]!.querySelector(':scope > .mbe-flow > p > strong')?.textContent).toBe('bold');
    expect(views[1]!.textContent).toBe('bold');
  });

  it('attaches what the sanitizer returns, attributes removed included, for inline HTML through the same hook', () => {
    const kinds: string[] = [];
    const root = create('Press <kbd onclick="alert(1)" class="key">**Ctrl**</kbd> now<br>next', {
      sanitizeHtml: (tree, ctx) => {
        kinds.push(ctx.kind);
        for (const el of Array.from(tree.querySelectorAll('*'))) for (const name of el.getAttributeNames()) if (name.startsWith('on')) el.removeAttribute(name);
        return tree;
      },
    }).root;
    expect(kinds).toEqual(['inline', 'inline']);
    const kbd = root.querySelector('p .mbe-view-html > kbd')!;
    expect(kbd.getAttribute('class')).toBe('key');
    expect(kbd.hasAttribute('onclick')).toBe(false);
    expect(kbd.querySelector('strong')?.textContent).toBe('Ctrl');
    expect(root.querySelector('p .mbe-view-html > br')).not.toBeNull();
    expect(root.querySelector('p')?.textContent).toBe('Press Ctrl nownext');
  });

  it('shows nothing while a sanitizer that returns a promise is pending, then the tree', async () => {
    let resolve!: (tree: DocumentFragment) => void;
    const root = create(SECTION, { sanitizeHtml: (tree) => new Promise<DocumentFragment>((r) => (resolve = r)).then(() => tree) }).root;
    const view = root.querySelector('.mbe-view-html')!;
    expect(view.textContent).toBe('');
    expect(root.querySelector('strong')).toBeNull();
    resolve(document.createDocumentFragment());
    await new Promise((r) => setTimeout(r, 50));
    expect(root.querySelector('.mbe-view-html > details > .mbe-flow strong')?.textContent).toBe('bold');
  });
});
