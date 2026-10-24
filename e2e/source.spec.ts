// Source mode: the whole document as plain Markdown text (README "Source mode").

import { readFileSync } from 'node:fs';
import { expect, md, type Page, test, viewProblems } from './helpers';

const open = (page: Page, markdown: string) => page.goto(`/?source&md=${encodeURIComponent(markdown)}`);
const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
const mode = (page: Page) => page.evaluate(() => (window as any).editor.mode as string);
const setMode = (page: Page, mode: 'rich' | 'source') => page.evaluate((mode) => (window as any).editor.setOptions({ mode }), mode);
/** The text shown in source mode: one element per line, without the line endings. */
const shown = (page: Page) => page.locator('#editor .mbe-source-text').evaluate((el) => Array.from(el.children, (line) => line.textContent).join('\n'));
const offsets = (page: Page) =>
  page.evaluate(() => {
    const { anchor, focus } = (window as any).editor.state.selection;
    return [anchor.offset, focus.offset];
  });
/** Puts the caret (or a selection) at text offsets in source mode. */
const select = (page: Page, from: number, to = from) =>
  page.evaluate(
    ([from, to]) => {
      const editor = (window as any).editor;
      const id = editor.state.doc.blocks[0].id;
      editor.focus();
      editor.setSelection({ anchor: { blockId: id, offset: from }, focus: { blockId: id, offset: to } });
    },
    [from, to],
  );
const paste = (page: Page, data: Record<string, string>) =>
  page.evaluate((data) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
    document.activeElement!.dispatchEvent((window as any).clipboardEvent('paste', transfer));
  }, data);

test('rich → source → rich leaves every fixture byte for byte, and source shows getMarkdown()', async ({ page }) => {
  test.setTimeout(120_000);
  const load = (name: string) =>
    (JSON.parse(readFileSync(new URL(`../packages/editor/test/fixtures/${name}`, import.meta.url), 'utf8')) as { markdown: string }[]).map((e) => e.markdown);
  const fixtures = [...load('commonmark-0.31.2.json'), ...load('gfm-extensions.json')];
  await page.goto('/');
  const sample = await md(page);
  const failures = await page.evaluate((all) => {
    const editor = (window as any).editor;
    const text = () => Array.from(document.querySelector('#editor .mbe-source-text')!.children, (line) => line.textContent).join('\n');
    const out: string[] = [];
    for (const markdown of all) {
      editor.setMarkdown(markdown);
      const before = editor.getMarkdown();
      editor.setOptions({ mode: 'source' });
      if (text() !== before) out.push(`shown: ${JSON.stringify(markdown)}`);
      if (editor.getMarkdown() !== before) out.push(`source: ${JSON.stringify(markdown)}`);
      editor.setOptions({ mode: 'rich' });
      if (editor.getMarkdown() !== before) out.push(`rich: ${JSON.stringify(markdown)}`);
    }
    return out;
  }, [sample, ...fixtures]);
  expect(failures).toEqual([]);
});

test('a switch emits no change, adds no undo step, and keeps focus', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent('hello\n')}`);
  await page.locator('#editor .mbe-block').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' world');
  await frame(page);
  await page.evaluate(() => {
    const editor = (window as any).editor;
    (window as any).changes = 0;
    editor.on('change', () => (window as any).changes++);
  });
  await page.locator('#toggle-source').click();
  expect(await mode(page)).toBe('source');
  await expect(page.locator('#toggle-source')).toHaveClass(/on/);
  expect(await shown(page)).toBe('hello world\n');
  await setMode(page, 'rich');
  await setMode(page, 'source');
  await frame(page);
  expect(await page.evaluate(() => (window as any).changes)).toBe(0);
  expect(await page.evaluate(() => (window as any).editor.hasFocus())).toBe(true);
  // The first undo undoes the typing, not the switch, and the mode stays.
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('hello\n');
  expect(await mode(page)).toBe('source');
  expect(await shown(page)).toBe('hello\n');
  await page.keyboard.press('Control+Shift+z');
  expect(await md(page)).toBe('hello world\n');
});

test('undo works across modes: an edit in source mode is undone and redone in rich mode', async ({ page }) => {
  await open(page, '# Title\n\n- a\n- b\n');
  await select(page, '# Title\n\n- a\n- b'.length);
  // Enter continues the list.
  await page.keyboard.type('\nc');
  expect(await md(page)).toBe('# Title\n\n- a\n- b\n- c\n');
  await setMode(page, 'rich');
  expect(await md(page)).toBe('# Title\n\n- a\n- b\n- c\n');
  // Enter is a step of its own, as in rich mode.
  await page.keyboard.press('ControlOrMeta+z');
  expect(await md(page)).toBe('# Title\n\n- a\n- b\n- \n');
  await page.keyboard.press('ControlOrMeta+z');
  expect(await md(page)).toBe('# Title\n\n- a\n- b\n');
  expect(await mode(page)).toBe('rich');
  expect(await viewProblems(page)).toEqual([]);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await md(page)).toBe('# Title\n\n- a\n- b\n- c\n');
  expect(await viewProblems(page)).toEqual([]);
});

test('the caret keeps its block and column across a switch', async ({ page }) => {
  const doc = '# Title\n\nsome text\n\n- item one\n';
  await page.goto(`/?md=${encodeURIComponent(doc)}`);
  await page.evaluate(() => {
    const editor = (window as any).editor;
    editor.focus();
    editor.setSelection({ anchor: { block: 2, offset: 4 }, focus: { block: 2, offset: 4 } });
  });
  await setMode(page, 'source');
  expect(await offsets(page)).toEqual([doc.indexOf('item one') + 4, doc.indexOf('item one') + 4]);
  await page.keyboard.type('X');
  expect(await md(page)).toBe('# Title\n\nsome text\n\n- itemX one\n');
  await setMode(page, 'rich');
  expect(await page.evaluate(() => (window as any).editor.selectionToJSON())).toEqual({
    anchor: { block: 2, offset: 5 },
    focus: { block: 2, offset: 5 },
  });
  await page.keyboard.type('Y');
  expect(await md(page)).toBe('# Title\n\nsome text\n\n- itemXY one\n');
});

test('typing edits plain text: no Markdown shortcuts or autolinks, and Shift+Enter is a line break', async ({ page }) => {
  await open(page, 'a\n');
  await select(page, 1);
  await page.keyboard.press('Enter');
  await page.keyboard.type('# b **c** https://x.org ');
  expect(await md(page)).toBe('a\n# b **c** https://x.org \n');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('d');
  expect(await md(page)).toBe('a\n# b **c** https://x.org\nd\n');
  expect(await page.locator('#editor .mbe-block').count()).toBe(1);
  expect(await shown(page)).toBe(await md(page));
  expect(await viewProblems(page)).toEqual([]);
});

test('Enter continues a list or task item, numbers the items after it, and ends the list on an empty item', async ({ page }) => {
  await open(page, '- [x] a\n');
  await select(page, 7);
  await page.keyboard.press('Enter');
  await page.keyboard.type('b');
  expect(await md(page)).toBe('- [x] a\n- [ ] b\n');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('c');
  expect(await md(page)).toBe('- [x] a\n- [ ] b\nc\n');

  await open(page, '1. a\n2. b\n');
  await select(page, 4);
  await page.keyboard.press('Enter');
  await page.keyboard.type('x');
  expect(await md(page)).toBe('1. a\n2. x\n3. b\n');
  // Shift+Enter is a line break, not a new item.
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('y');
  expect(await md(page)).toBe('1. a\n2. x\ny\n3. b\n');
  expect(await shown(page)).toBe(await md(page));
});

test('Enter in a nested empty item outdents it, and Enter on a new item is one undo step', async ({ page }) => {
  await open(page, '- a\n  - b\n');
  await select(page, 9);
  await page.keyboard.press('Enter');
  expect(await md(page)).toBe('- a\n  - b\n  - \n');
  await page.keyboard.press('Enter');
  expect(await md(page)).toBe('- a\n  - b\n- \n');
  expect(await offsets(page)).toEqual([12, 12]);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await md(page)).toBe('- a\n  - b\n  - \n');
  await page.keyboard.press('ControlOrMeta+z');
  expect(await md(page)).toBe('- a\n  - b\n');
  expect(await offsets(page)).toEqual([9, 9]);
});

test('Backspace at the start and Delete at the end do nothing', async ({ page }) => {
  await open(page, 'ab');
  await select(page, 0);
  await page.keyboard.press('Backspace');
  await select(page, 2);
  await page.keyboard.press('Delete');
  expect(await md(page)).toBe('ab');
  await page.keyboard.press('Backspace');
  expect(await md(page)).toBe('a');
});

test('Tab and Shift+Tab indent other lines as in a code block', async ({ page }) => {
  await open(page, 'a\nb\n');
  await select(page, 0);
  await page.keyboard.press('Tab');
  expect(await md(page)).toBe('  a\nb\n');
  await select(page, 0, 5);
  await page.keyboard.press('Tab');
  expect(await md(page)).toBe('    a\n  b\n');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  expect(await md(page)).toBe('a\nb\n');
  expect(await page.evaluate(() => (window as any).editor.hasFocus())).toBe(true);
});

test('Tab and Shift+Tab nest list items under the item before, with their nested lines, and number them', async ({ page }) => {
  await open(page, '1. a\n2. b\n   - c\n3. d\n');
  await select(page, 6);
  await page.keyboard.press('Tab');
  expect(await md(page)).toBe('1. a\n   1. b\n      - c\n2. d\n');
  expect(await offsets(page)).toEqual([9, 9]);
  await page.keyboard.press('Shift+Tab');
  expect(await md(page)).toBe('1. a\n2. b\n   - c\n3. d\n');
  // The first item has nothing to nest under: Tab keeps it and keeps focus.
  await select(page, 1);
  await page.keyboard.press('Tab');
  expect(await md(page)).toBe('1. a\n2. b\n   - c\n3. d\n');
  expect(await page.evaluate(() => (window as any).editor.hasFocus())).toBe(true);
  // commands.indent works the same way.
  await select(page, 21);
  expect(await page.evaluate(() => (window as any).editor.commands.indent())).toBe(true);
  expect(await md(page)).toBe('1. a\n2. b\n   - c\n   1. d\n');
});

test('smartLists: false makes Enter a line break and Tab indent as in a code block', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const w = window as any;
    w.editor.destroy();
    w.editor = new w.core.Editor({ element: document.getElementById('editor'), content: '- a\n- b\n', mode: 'source', smartLists: false });
  });
  await select(page, 3);
  await page.keyboard.press('Enter');
  expect(await md(page)).toBe('- a\n\n- b\n');
  await select(page, 5);
  await page.keyboard.press('Tab');
  expect(await md(page)).toBe('- a\n\n  - b\n');
});

test('formatting keys and commands do nothing', async ({ page }) => {
  await open(page, 'word\n');
  await select(page, 0, 4);
  for (const key of ['Control+b', 'Control+i', 'Control+e', 'Control+Shift+x', 'Control+Alt+2', 'Control+Alt+0', 'Control+Alt+c', 'Control+Shift+8', 'Control+Shift+6']) {
    await page.keyboard.press(key);
  }
  expect(await md(page)).toBe('word\n');
  const results = await page.evaluate(() => {
    const { commands } = (window as any).editor;
    return [
      commands.toggleBold(),
      commands.toggleHeading({ level: 1 }),
      commands.toggleBulletList(),
      commands.toggleCodeBlock(),
      commands.setLink({ href: 'https://x.org' }),
      commands.insertTable(),
      commands.insertDivider(),
      commands.toggleCallout(),
      commands.toggleDetails(),
      commands.selectBlocks(),
    ];
  });
  expect(results.every((r) => r === false)).toBe(true);
  expect(await md(page)).toBe('word\n');
  const state = await page.evaluate(() => {
    const editor = (window as any).editor;
    return { bold: editor.isActive('bold'), code: editor.isActive('codeBlock'), attrs: editor.getAttributes('codeBlock') };
  });
  expect(state).toEqual({ bold: false, code: false, attrs: {} });
  await expect(page.locator('.mbe-toolbar:visible')).toHaveCount(0);
});

test('no autocomplete: no suggestion popup, slash menu or Ctrl+Space', async ({ page }) => {
  await open(page, 'x\n');
  await select(page, 1);
  await page.keyboard.type(' #wo @al :smi');
  await page.keyboard.press('Control+Space');
  await page.keyboard.type('\n/');
  await frame(page);
  await expect(page.locator('.mbe-menu-item:visible')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).editor.suggestion.state)).toBeNull();
  expect(await md(page)).toBe('x #wo @al :smi\n/\n');
});

test('Escape leaves the editor', async ({ page }) => {
  await open(page, 'x\n');
  await select(page, 1);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).editor.hasFocus())).toBe(false);
  expect(await page.evaluate(() => (window as any).editor.selectedBlocks.length)).toBe(0);
});

test('paste inserts the plain text as written; copy and cut write the selected text', async ({ page }) => {
  await open(page, 'ab\n');
  await select(page, 1);
  await paste(page, { 'text/plain': '**x**\r\n- y', 'text/html': '<b>z</b>' });
  expect(await md(page)).toBe('a**x**\n- yb\n');
  // HTML alone pastes nothing: source mode takes plain text only.
  await paste(page, { 'text/html': '<b>z</b>' });
  expect(await md(page)).toBe('a**x**\n- yb\n');
  await select(page, 1, 6);
  const copied = await page.evaluate(() => {
    const transfer = new DataTransfer();
    document.activeElement!.dispatchEvent((window as any).clipboardEvent('cut', transfer));
    return [transfer.getData('text/plain'), transfer.getData('text/html')];
  });
  expect(copied).toEqual(['**x**', '']);
  expect(await md(page)).toBe('a\n- yb\n');
});

test('Mod+A selects all the text, and Mod+Enter submits', async ({ page }) => {
  await open(page, 'one\n\ntwo\n');
  await select(page, 2);
  await page.keyboard.press('Control+a');
  expect(await offsets(page)).toEqual([0, 9]);
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('body')).toHaveAttribute('data-submitted', '1');
});

test('the placeholder shows when the text is empty', async ({ page }) => {
  await page.goto('/?empty&source');
  const content = () =>
    page.locator('#editor .mbe-source-text').evaluate((el) => getComputedStyle(el, '::before').content);
  expect(await content()).toContain('Write something');
  await page.locator('#editor').click();
  await page.keyboard.type('a');
  expect(await content()).toBe('none');
});

test('read-only: the text can be selected but not edited', async ({ page }) => {
  await open(page, 'abc\n');
  await page.locator('#toggle-readonly').click();
  await expect(page.locator('#editor')).toHaveAttribute('contenteditable', 'false');
  await select(page, 0, 3);
  await page.keyboard.type('x');
  expect(await md(page)).toBe('abc\n');
});

test('a widget stays below the text, follows edits before it, and takes insertMarkdown at its place', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent('one\n\ntwo\n')}`);
  await page.evaluate(() => {
    const editor = (window as any).editor;
    (window as any).widget = editor.addWidget({ at: { block: 0, offset: 0 }, render: (el: HTMLElement) => (el.textContent = 'uploading') });
  });
  await setMode(page, 'source');
  await expect(page.locator('#editor > .mbe-widget')).toHaveText('uploading');
  expect(await page.locator('#editor > *').evaluateAll((els) => els.map((el) => el.className.split(' ')[0]))).toEqual(['mbe-block', 'mbe-widget']);
  await select(page, 0);
  await page.keyboard.type('zero ');
  await page.evaluate(() => {
    const { editor, widget } = window as any;
    editor.commands.insertMarkdown('![](a.png)', { at: widget, block: true });
    widget.remove();
  });
  expect(await md(page)).toBe('zero one\n![](a.png)\n\ntwo\n');
  await setMode(page, 'rich');
  expect(await md(page)).toBe('zero one\n![](a.png)\n\ntwo\n');
});

test('insertText and insertMarkdown insert text as written', async ({ page }) => {
  await open(page, 'ab\n');
  await select(page, 1);
  await page.evaluate(() => {
    const { commands } = (window as any).editor;
    commands.insertText('**');
    commands.insertMarkdown('# h', { block: true });
  });
  expect(await md(page)).toBe('a**\n# h\nb\n');
});

test('the source mode option works on creation, and the URL toggle button switches back', async ({ page }) => {
  await open(page, '**bold**\n');
  expect(await mode(page)).toBe('source');
  await expect(page.locator('#editor .mbe-source')).toHaveCount(1);
  expect(await shown(page)).toBe('**bold**\n');
  // The text is in the body font, at the body's size and line height; the sourceFont token changes the font.
  const font = (selector: string) =>
    page.locator(selector).evaluate((el) => [getComputedStyle(el).fontFamily, getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight]);
  const [sourceFont, size, lineHeight] = await font('#editor .mbe-source');
  const [bodyFont, bodySize, bodyLineHeight] = await font('#editor');
  expect(sourceFont).toBe(bodyFont);
  expect([size, lineHeight]).toEqual([bodySize, bodyLineHeight]);
  await page.evaluate(() => (window as any).editor.setOptions({ theme: { tokens: { sourceFont: 'monospace' } } }));
  expect((await font('#editor .mbe-source'))[0]).toBe('monospace');
  await page.evaluate(() => (window as any).editor.setOptions({ theme: undefined }));
  await page.locator('#toggle-source').click();
  expect(await mode(page)).toBe('rich');
  await expect(page.locator('#editor strong')).toHaveText('bold');
  await expect(page.locator('#editor .mbe-source')).toHaveCount(0);
});

test('React: the mode prop switches live without recreating the editor', async ({ page }) => {
  await page.goto('/react.html?demo=api');
  const root = page.locator('#controlled .mbe-root');
  await root.evaluate((el) => (el.dataset.marked = '1'));
  await page.locator('#mode').click();
  await expect(root.locator('.mbe-source')).toHaveText('start\n');
  await expect(root).toHaveAttribute('data-marked', '1');
  await root.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('**');
  await expect(page.locator('#value')).toHaveText('start**\n');
  await page.locator('#mode').click();
  await expect(root.locator('.mbe-source')).toHaveCount(0);
  await expect(page.locator('#value')).toHaveText('start**\n');
});

test('IME text in source mode is inserted once; a switch during composition waits for it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'IME is simulated through the Chrome DevTools Protocol');
  await page.goto('/?empty&source');
  await page.locator('#editor').click();
  const cdp = await page.context().newCDPSession(page);
  for (const text of ['n', 'ni', 'に']) {
    await frame(page);
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  await frame(page);
  await setMode(page, 'rich');
  expect(await mode(page)).toBe('rich');
  await expect(page.locator('#editor .mbe-source')).toHaveCount(1);
  await cdp.send('Input.insertText', { text: '日本' });
  await frame(page);
  expect(await md(page)).toBe('日本');
  await expect(page.locator('#editor .mbe-source')).toHaveCount(0);
  await expect(page.locator('#editor p')).toHaveText('日本');
});

test('highlights the Markdown syntax without changing the text: markers dimmed, strong bold, code mono, URLs tinted', async ({ page }) => {
  const text = '# Title\n\nsome **bold** and `code` and [a link](https://x.y)\n';
  await open(page, text);
  expect(await shown(page)).toBe(text);
  const texts = (cls: string) => page.locator(`#editor .mbe-source .${cls}`).allTextContents();
  expect(await texts('mbe-src-marker')).toEqual(['#', '**', '**', '`', '`', '[', ']', '(', ')']);
  expect(await texts('mbe-src-heading')).toEqual(['Title']);
  expect(await texts('mbe-src-strong')).toEqual(['bold']);
  expect(await texts('mbe-src-code')).toEqual(['code']);
  expect(await texts('mbe-src-link')).toEqual(['a link']);
  expect(await texts('mbe-src-url')).toEqual(['https://x.y']);
  const style = (cls: string, prop: string) => page.locator(`#editor .mbe-source .${cls}`).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  const body = await page.locator('#editor .mbe-source-text').evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).fontSize, getComputedStyle(el).fontFamily]);
  expect(Number(await style('mbe-src-strong', 'font-weight'))).toBeGreaterThanOrEqual(600);
  expect(Number(await style('mbe-src-heading', 'font-weight'))).toBeGreaterThanOrEqual(600);
  expect(await style('mbe-src-marker', 'color')).not.toBe(body[0]);
  expect(await style('mbe-src-url', 'color')).not.toBe(body[0]);
  expect(await style('mbe-src-code', 'font-family')).not.toBe(body[2]);
  // Nothing changes size: the heading and the code are at the body's size.
  expect(await style('mbe-src-heading', 'font-size')).toBe(body[1]);
  expect(await style('mbe-src-code', 'font-size')).toBe(body[1]);
  // The text is in the body font, not mono.
  expect(body[2]).not.toContain('mono');
});

test('a literal star and a hash in a fence are not markup, and tags are highlighted in prose only', async ({ page }) => {
  await open(page, 'a * b #tag `#code` [#link](https://x.y/#url)\n\n```\n# not a heading\n```\n');
  expect(await page.locator('#editor .mbe-source .mbe-src-marker').allTextContents()).toEqual(['`', '`', '[', ']', '(', ')', '```', '```']);
  expect(await page.locator('#editor .mbe-source .mbe-src-heading').count()).toBe(0);
  expect(await page.locator('#editor .mbe-source .mbe-src-code').allTextContents()).toEqual(['#code', '# not a heading']);
  expect(await page.locator('#editor .mbe-source .tag').allTextContents()).toEqual(['#tag', '#link']);
});

test('sourceHighlighting: false leaves the text plain while the extensions still decorate it', async ({ page }) => {
  await page.goto(`/?source&nohighlight&md=${encodeURIComponent('see #tag **bold**\n')}`);
  expect(await shown(page)).toBe('see #tag **bold**\n');
  expect(await page.locator('#editor .mbe-source [class*="mbe-src-"]').count()).toBe(0);
  expect(await page.locator('#editor .mbe-source .tag').allTextContents()).toEqual(['#tag']);
});

test('codeDecorations run on the code of each fence in source mode', async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(() => {
    const { Editor } = (window as any).core;
    (window as any).editor.destroy();
    (window as any).editor = new Editor({
      element: document.getElementById('editor'),
      mode: 'source',
      content: 'text\n\n```js\nlet x = 1;\n```\n\n~~~\nplain\n~~~\n',
      extensions: [
        {
          name: 'highlighter',
          codeDecorations: ({ text, language }: { text: string; language: string }) =>
            language === 'js' ? [{ from: 0, to: 3, class: 'kw' }, { from: 0, to: text.length + 100, class: 'all' }] : [{ from: 0, to: 2, class: 'pl' }],
        },
      ],
    });
  });
  expect(await page.locator('#editor .mbe-source .kw').allTextContents()).toEqual(['let']);
  // A decoration past the code's end is clipped to it (in pieces, where another decoration splits it).
  expect((await page.locator('#editor .mbe-source .all').allTextContents()).join('')).toBe('let x = 1;');
  expect(await page.locator('#editor .mbe-source .pl').allTextContents()).toEqual(['pl']);
  expect(await page.locator('#editor .mbe-source .mbe-src-lang').allTextContents()).toEqual(['js']);
});

test('typing keeps the highlighting current, and the shown text stays the Markdown', async ({ page }) => {
  await open(page, 'one **two** three\n');
  await select(page, 'one **two'.length);
  await page.keyboard.type('x');
  expect(await md(page)).toBe('one **twox** three\n');
  expect(await shown(page)).toBe('one **twox** three\n');
  expect(await page.locator('#editor .mbe-source .mbe-src-strong').allTextContents()).toEqual(['twox']);
  // Closing the emphasis later highlights it.
  await open(page, 'one **two three\n');
  expect(await page.locator('#editor .mbe-source .mbe-src-strong').count()).toBe(0);
  await select(page, 'one **two'.length);
  await page.keyboard.type('**');
  expect(await shown(page)).toBe('one **two** three\n');
  expect(await page.locator('#editor .mbe-source .mbe-src-strong').allTextContents()).toEqual(['two']);
});
