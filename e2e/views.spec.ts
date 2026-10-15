// Rendered views: math shows as formulas, and its source shows at the caret.

import { expect, md, test } from './helpers';

const DOC = 'Euler $e^{i\\pi}+1=0$ here\n\n$$\n\\frac{1}{2}\n$$\n\nend';
const open = (page: import('@playwright/test').Page) => page.goto(`/?md=${encodeURIComponent(DOC)}`);
const selection = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).editor.selectionToJSON());
const caret = (block: number, offset: number) => ({ anchor: { block, offset }, focus: { block, offset } });

test('math shows as formulas, the same when read-only, and saves its source', async ({ page }) => {
  await open(page);
  const editor = page.locator('#editor');
  await expect(editor.locator('.mbe-view-math .katex')).toHaveCount(1);
  await expect(editor.locator('.mbe-view-block .katex-display')).toHaveCount(1);
  await expect(editor.locator('.mbe-token, pre.mbe-raw')).toHaveCount(0);
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  await expect(editor.locator('.mbe-view-math .katex')).toHaveCount(1);
  await expect(editor.locator('.mbe-view-block .katex-display')).toHaveCount(1);
  expect(await md(page)).toBe(DOC);
});

test('clicking a formula shows its source to edit; moving away renders it again', async ({ page }) => {
  await open(page);
  const editor = page.locator('#editor');
  await editor.locator('.mbe-view-math').click();
  await expect(editor.locator('.mbe-token-math')).toHaveText('$e^{i\\pi}+1=0$');
  expect(await selection(page)).toEqual(caret(0, 20));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('2');
  expect(await md(page)).toBe(DOC.replace('=0$', '=2$'));
  await page.keyboard.press('End');
  await expect(editor.locator('.mbe-view-math .katex')).toHaveCount(1);
  await expect(editor.locator('.mbe-token-math')).toHaveCount(0);

  // A math block: the caret lands at the end of the formula's last line.
  await editor.locator('.mbe-view-block').click();
  await expect(editor.locator('pre.mbe-raw[data-syntax="math"]')).toHaveText('$$\n\\frac{1}{2}\n$$');
  expect(await selection(page)).toEqual(caret(1, 14));
});

test('arrow keys step into a math block source and out again', async ({ page }) => {
  await open(page);
  const editor = page.locator('#editor');
  await editor.locator('p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  await expect(editor.locator('.mbe-view-block')).toHaveCount(0);
  await expect.poll(() => selection(page)).toEqual(caret(1, 3));
  await page.keyboard.type('2');
  expect(await md(page)).toContain('$$\n2\\frac{1}{2}\n$$');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => selection(page).then((s) => s.focus.block)).toBe(2);
  await expect(editor.locator('.mbe-view-block .katex-display')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => selection(page)).toEqual(caret(1, 15));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => selection(page).then((s) => s.focus.block)).toBe(2);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => selection(page)).toEqual(caret(1, 15));
});

test('codeDecorations highlight code while it is edited, and never reach the saved Markdown', async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(() => {
    const { Editor } = (window as any).core;
    const w = window as any;
    w.editor.destroy();
    w.editor = new Editor({
      element: document.getElementById('editor'),
      content: '```js\nconst x = 1;\n```',
      extensions: [
        {
          name: 'keywords',
          codeDecorations: ({ text, language }: { text: string; language: string }) =>
            language === 'js' ? [...text.matchAll(/\b(const|let)\b/g)].map((m) => ({ from: m.index, to: m.index! + m[0].length, class: 'kw' })) : [],
        },
      ],
    });
  });
  const code = page.locator('#editor .mbe-code code');
  await expect(code.locator('.kw')).toHaveText(['const']);
  await code.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('let y = 2;');
  await expect(code.locator('.kw')).toHaveText(['const', 'let']);
  expect(await md(page)).toBe('```js\nconst x = 1;\nlet y = 2;\n```');
});

test('a code: view renders code blocks of its language; a pending view shows its placeholder until it settles', async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(() => {
    const { Editor } = (window as any).core;
    const w = window as any;
    w.finish = {} as Record<string, (ok: boolean) => void>;
    w.editor.destroy();
    w.editor = new Editor({
      element: document.getElementById('editor'),
      content: 'before\n\n```diagram\nA -> B\n```\n\n```diagram\nbad\n```\n\nafter',
      extensions: [
        {
          name: 'diagrams',
          views: {
            'code:diagram': (source: string, el: HTMLElement) => {
              el.textContent = 'drawing…';
              return new Promise<void | false>((resolve) => {
                w.finish[source] = (ok: boolean) => {
                  el.textContent = `diagram: ${source}`;
                  resolve(ok ? undefined : false);
                };
              });
            },
          },
        },
      ],
    });
  });
  const views = page.locator('#editor .mbe-view-block');
  await expect(views).toHaveText(['drawing…', 'drawing…']);
  await page.evaluate(() => {
    const w = window as any;
    w.finish['A -> B'](true);
    w.finish['bad'](false);
  });
  await expect(views).toHaveText(['diagram: A -> B']);
  await expect(page.locator('#editor .mbe-code code')).toHaveText('bad');
  // Clicking the diagram shows its code to edit.
  await views.click();
  await expect(page.locator('#editor .mbe-code code').first()).toHaveText('A -> B');
  expect(await md(page)).toBe('before\n\n```diagram\nA -> B\n```\n\n```diagram\nbad\n```\n\nafter');
});

test('an html view renders inline raw HTML a run at a time, and its source shows at the caret', async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(() => {
    const { Editor } = (window as any).core;
    const w = window as any;
    w.editor.destroy();
    w.editor = new Editor({
      element: document.getElementById('editor'),
      content: 'Press <kbd>**Ctrl**</kbd> now<br>next <span>open',
      extensions: [{ name: 'html', views: { html: (source: string, el: HTMLElement) => void (el.textContent = `[${source}]`) } }],
    });
  });
  const views = page.locator('#editor .mbe-view-html');
  // The view gets the tags; the Markdown between them renders as the editor's own.
  await expect(views).toHaveText(['[<kbd>Ctrl</kbd>]', '[<br>]', '[<span>]']);
  await expect(views.first().locator('strong')).toHaveText('Ctrl');
  await expect(page.locator('#editor .mbe-raw-html')).toHaveCount(0);
  // Typing after a run keeps it rendered; the saved Markdown never changes.
  await page.locator('#editor').click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  expect(await page.evaluate(() => (window as any).editor.getMarkdown())).toBe('Press <kbd>**Ctrl**</kbd> now<br>next <span>open!');
  // A click shows the run's source to edit.
  await views.first().click();
  await expect(views).toHaveCount(2);
  await expect(page.locator('#editor .mbe-raw-html').first()).toHaveText('<kbd>');
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  await expect(views).toHaveCount(3);
});

test('footnotes render as a raised label and a note, and a reference leads to its note when read-only', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent('Fact[^1] and more[^note].\n\n[^1]: The source,\n  with a second line.\n\n[^note]: Another.')}`);
  const editor = page.locator('#editor');
  await expect(editor.locator('.mbe-footnote-ref')).toHaveText(['1', 'note']);
  await expect(editor.locator('.mbe-footnote')).toHaveText(['1The source, with a second line.', 'noteAnother.']);
  await expect(editor.locator('.mbe-token-footnote')).toHaveCount(0);
  // While editing, a reference shows its source at the caret.
  await editor.locator('.mbe-footnote-ref').first().click();
  await expect(editor.locator('.mbe-token-footnote')).toHaveText('[^1]');
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  await expect(editor.locator('.mbe-footnote-ref')).toHaveCount(2);
  expect(await md(page)).toBe('Fact[^1] and more[^note].\n\n[^1]: The source,\n  with a second line.\n\n[^note]: Another.');
});

test('math renders through a renderer that loads on demand', async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(() => {
    const { Editor, math } = (window as any).core;
    const w = window as any;
    w.editor.destroy();
    let loaded: () => void = () => {};
    w.load = () => loaded();
    const ready = new Promise<void>((resolve) => (loaded = resolve));
    w.editor = new Editor({
      element: document.getElementById('editor'),
      content: 'Euler $e$ here',
      editable: false,
      extensions: [math({ render: (tex: string, el: HTMLElement) => ready.then(() => void (el.textContent = `formula ${tex}`)) })],
    });
  });
  const view = page.locator('#editor .mbe-view-math');
  await expect(view).toHaveText('$e$');
  await page.evaluate(() => (window as any).load());
  await expect(view).toHaveText('formula e');
});

// HTML sections: an element whose tags are in different HTML blocks, with Markdown between them (memos#6477).
const SECTION = [
  '<details><summary>Test</summary>',
  '',
  '> 💡 **Tip**',
  '> Test[^1] #tag',
  '',
  '',
  '```',
  'Some code here',
  '```',
  '',
  '</details>',
  '',
  '[^1]: very important',
].join('\n');

/** An editor whose `html` view parses HTML as is: a test stand-in for a sanitizing renderer. */
const sectionEditor = (page: import('@playwright/test').Page, content: string, options: { editable?: boolean; markdownView?: boolean } = {}) =>
  page.evaluate(
    ({ content, options }) => {
      const { Editor, footnotes, tags } = (window as any).core;
      const w = window as any;
      w.editor.destroy();
      w.views = [] as string[];
      const html = (source: string, el: HTMLElement) => {
        w.views.push(source);
        const template = document.createElement('template');
        // A Markdown renderer wraps a line of its own in a paragraph, as memos' remark pipeline does.
        template.innerHTML = options.markdownView ? source.replace(/\n\n(\uE000\d+\uE001)\n\n/g, '<p>$1</p>') : source;
        el.append(template.content);
      };
      w.editor = new Editor({
        element: document.getElementById('editor'),
        content,
        editable: options.editable ?? true,
        // <details> as an HTML section, not a collapsible section of blocks, so the view renders it.
        markdown: { breaks: true, details: false },
        extensions: [footnotes(), tags(), { name: 'html', views: { html } }],
      });
    },
    { content, options },
  );

test('an HTML section renders its HTML through the view and the Markdown inside as blocks', async ({ page }) => {
  await page.goto('/?empty');
  await sectionEditor(page, SECTION, { editable: false });
  const editor = page.locator('#editor');
  const details = editor.locator('.mbe-view-html > details');
  await expect(details).toHaveCount(1);
  await expect(details.locator('summary')).toHaveText('Test');
  // The view never sees the Markdown, only the HTML around it.
  expect(await page.evaluate(() => (window as any).views)).toEqual(['<details><summary>Test</summary>\n\n\uE0000\uE001\n\n</details>']);
  // The quote, code block, footnote reference and tag inside render as they do anywhere else.
  await details.locator('summary').click();
  await expect(details.locator('.mbe-flow > blockquote.mbe-block')).toHaveText('💡 Tip\nTest1 #tag');
  await expect(details.locator('.mbe-flow strong')).toHaveText('Tip');
  await expect(details.locator('.mbe-footnote-ref')).toHaveText('1');
  await expect(details.locator('.mbe-tag')).toHaveText('#tag');
  await expect(details.locator('.mbe-flow > .mbe-code pre code')).toHaveText('Some code here');
  await expect(editor.locator(':scope > .mbe-footnote')).toHaveText('1very important');
  // Styled as blocks: a quote has its bar, and code is a block, not inline code.
  expect(await details.locator('blockquote').evaluate((el) => getComputedStyle(el).borderInlineStartWidth)).toBe('3px');
  expect(await details.locator('pre code').evaluate((el) => getComputedStyle(el).display)).toBe('block');
  // Line breaks between the tags are not text: the summary sits one block gap above the quote.
  const gap = await details.evaluate((el) => el.querySelector('blockquote')!.getBoundingClientRect().top - el.querySelector('summary')!.getBoundingClientRect().bottom);
  expect(gap).toBe(8);
  // Nothing inside is a block of the document, editable, or in the saved Markdown.
  await expect(details.locator('[data-block-id], [data-content], [contenteditable]')).toHaveCount(0);
  expect(await md(page)).toBe(SECTION);
});

test('a reference inside a section leads to its note, and the section stays open when its block renders again', async ({ page }) => {
  await page.goto('/?empty');
  await sectionEditor(page, `<div style="margin-top: 1500px"></div>\n\n${SECTION}`, { editable: false });
  const details = page.locator('#editor details');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
  await page.evaluate(() => (window as any).editor.redecorate());
  await expect(details).toHaveAttribute('open', '');
  await details.locator('.mbe-footnote-ref').click();
  await expect(page.locator('#editor .mbe-footnote')).toBeInViewport();
});

test('a section reads the same through a view that renders Markdown, which wraps a slot in a paragraph', async ({ page }) => {
  await page.goto('/?empty');
  await sectionEditor(page, SECTION, { editable: false, markdownView: true });
  const details = page.locator('#editor details');
  await expect(details.locator(':scope > .mbe-flow > blockquote')).toHaveCount(1);
  await expect(details.locator('p:has(.mbe-flow)')).toHaveCount(0);
});

test('any HTML element can hold Markdown: centered text, table cells and nested sections', async ({ page }) => {
  await page.goto('/?empty');
  const content = [
    '<div align="center">',
    '',
    '# Title',
    '',
    '- one',
    '- two',
    '',
    '<details>',
    '<summary>More</summary>',
    '',
    '1. first',
    '',
    '</details>',
    '',
    '</div>',
    '',
    '<table>',
    '<tr>',
    '<td>',
    '',
    '**cell**',
    '',
    '</td>',
    '</tr>',
    '</table>',
  ].join('\n');
  await sectionEditor(page, content, { editable: false });
  const editor = page.locator('#editor');
  const div = editor.locator('.mbe-view-html > div[align="center"]');
  await expect(div.locator(':scope > .mbe-flow > h1')).toHaveText('Title');
  await expect(div.locator(':scope > .mbe-flow > .mbe-list-item')).toHaveText(['one', 'two']);
  await expect(div.locator('details > .mbe-flow .mbe-marker')).toHaveText('1.');
  await expect(editor.locator('td > .mbe-flow strong')).toHaveText('cell');
  expect(await md(page)).toBe(content);
});

test('clicking a section while editing shows its source to edit', async ({ page }) => {
  await page.goto('/?empty');
  await sectionEditor(page, `before\n\n${SECTION}`);
  const editor = page.locator('#editor');
  await editor.locator('details summary').click();
  await expect(editor.locator('pre.mbe-raw[data-syntax="html"]')).toHaveText(SECTION.slice(0, SECTION.indexOf('\n\n[^1]')));
  await expect(editor.locator('details')).toHaveCount(0);
  // Moving away renders it again.
  await editor.locator('p').first().click();
  await expect(editor.locator('details')).toHaveCount(1);
  expect(await md(page)).toBe(`before\n\n${SECTION}`);
});

test('the copy button of a code block inside a section copies its code', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Reading the clipboard needs Chromium permissions');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?empty');
  await sectionEditor(page, '<details open>\n<summary>S</summary>\n\n```js\nconst a = 1;\n```\n\n</details>', { editable: false });
  const code = page.locator('#editor details .mbe-code');
  await code.hover();
  await code.locator('.mbe-code-copy').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const a = 1;');
});
