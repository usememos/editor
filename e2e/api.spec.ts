// The public Editor API: commands, state queries, selection, events and options.

import { expect, test } from '@playwright/test';
import { blocks, md } from './helpers';

const open = (page: import('@playwright/test').Page, markdown: string) => page.goto(`/?md=${encodeURIComponent(markdown)}`);

test('commands change the document and report whether they did something', async ({ page }) => {
  await open(page, 'hello world');
  const result = await page.evaluate(() => {
    const editor = (window as any).editor;
    editor.commands.focus('end');
    const results = [
      editor.commands.toggleHeading({ level: 2 }),
      editor.commands.toggleBulletList(),
      editor.commands.toggleBulletList(),
      editor.commands.selectAll(),
      editor.commands.toggleBold(),
      editor.commands.unsetLink(),
    ];
    return results;
  });
  expect(result).toEqual([true, true, true, true, true, false]);
  expect(await md(page)).toBe('**hello world**');
  await page.evaluate(() => (window as any).editor.commands.undo());
  expect(await blocks(page)).toEqual(['p:hello world']);
});

test('isActive and getAttributes describe the selection', async ({ page }) => {
  await open(page, '## Title\n\n[link](https://a.com) and **bold**\n\n```js\nx\n```');
  const result = await page.evaluate(() => {
    const editor = (window as any).editor;
    const at = (block: number, offset: number) => editor.setSelection({ anchor: { block, offset }, focus: { block, offset } });
    at(0, 2);
    const heading = [editor.isActive('heading'), editor.isActive('heading', { level: 2 }), editor.isActive('heading', { level: 1 }), editor.getAttributes('heading')];
    at(1, 2);
    const link = [editor.isActive('link'), editor.getAttributes('link'), editor.isActive('paragraph')];
    editor.setSelection({ anchor: { block: 1, offset: 9 }, focus: { block: 1, offset: 13 } });
    const bold = editor.isActive('bold');
    at(2, 0);
    const code = [editor.isActive('codeBlock', { language: 'js' }), editor.getAttributes('codeBlock')];
    return { heading, link, bold, code };
  });
  expect(result).toEqual({
    heading: [true, true, false, { level: 2 }],
    link: [true, { href: 'https://a.com' }, true],
    bold: true,
    code: [true, { language: 'js' }],
  });
});

test('a selection saved as JSON restores after reloading the same Markdown; junk is ignored', async ({ page }) => {
  await open(page, 'one\n\n| a | b |\n| - | - |\n| c | d |\n\nthree');
  const result = await page.evaluate(() => {
    const editor = (window as any).editor;
    editor.setSelection({ anchor: { block: 1, offset: 1, cell: { row: 1, col: 1 } }, focus: { block: 1, offset: 1, cell: { row: 1, col: 1 } } });
    const saved = JSON.parse(JSON.stringify(editor.selectionToJSON()));
    editor.setMarkdown(editor.getMarkdown());
    editor.setSelection(saved);
    const restored = editor.selectionToJSON();
    const junk = [editor.setSelection(42), editor.setSelection({ anchor: 'x' })];
    editor.setSelection({ anchor: { block: 99, offset: 99 }, focus: { block: 99, offset: 99 } });
    return { saved, restored, junk, clamped: editor.selectionToJSON() };
  });
  expect(result.restored).toEqual(result.saved);
  expect(result.junk).toEqual([false, false]);
  expect(result.clamped).toEqual({ anchor: { block: 2, offset: 5 }, focus: { block: 2, offset: 5 } });
});

test('insertMarkdown inserts at the caret, as its own block, or at the end', async ({ page }) => {
  await open(page, 'hello world');
  await page.evaluate(() => {
    const editor = (window as any).editor;
    editor.setSelection({ anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 5 } });
    editor.commands.insertMarkdown('![img](/a.png)', { at: editor.getSelection().focus, block: true, select: 'keep' });
    editor.commands.insertMarkdown('- end', { at: 'end', select: 'keep' });
  });
  // The text after the split keeps its leading space, written as a character reference.
  expect(await md(page)).toBe('hello\n\n![img](/a.png)\n\n&#32;world\n\n- end');
  const selected = await page.evaluate(() => (window as any).editor.selectionToJSON());
  expect(selected).toEqual({ anchor: { block: 0, offset: 0 }, focus: { block: 0, offset: 5 } });
});

test('events: change once per frame, selectionChange, submit on Ctrl+Enter, unsubscribe', async ({ page }) => {
  await open(page, '');
  await page.evaluate(() => {
    const editor = (window as any).editor;
    const log: string[] = ((window as any).log = []);
    editor.on('change', () => log.push('change'));
    editor.on('submit', () => log.push('submit'));
    const off = editor.on('selectionChange', () => log.push('selection'));
    (window as any).offSelection = off;
  });
  await page.locator('#editor').click();
  await page.keyboard.type('abc');
  await page.keyboard.press('Control+Enter');
  const log: string[] = await page.evaluate(() => (window as any).log);
  expect(log.filter((e) => e === 'submit')).toHaveLength(1);
  expect(log.filter((e) => e === 'change').length).toBeGreaterThanOrEqual(1);
  expect(log.filter((e) => e === 'change').length).toBeLessThanOrEqual(3);
  expect(log).toContain('selection');
  const after = await page.evaluate(() => {
    (window as any).offSelection();
    (window as any).log.length = 0;
    (window as any).editor.commands.selectAll();
    return (window as any).log;
  });
  expect(after).toEqual([]);
});

test('setOptions changes the placeholder, attributes, editability and image URLs', async ({ page }) => {
  await open(page, '![a](/file/x.png)');
  await page.evaluate(() => {
    const editor = (window as any).editor;
    editor.setOptions({
      placeholder: 'New placeholder',
      attributes: { autocorrect: 'on', 'aria-label': 'Memo' },
      resolveImageSrc: (src: string) => `https://cdn.example${src}`,
    });
  });
  const root = page.locator('#editor');
  await expect(root).toHaveAttribute('autocorrect', 'on');
  await expect(root).toHaveAttribute('aria-label', 'Memo');
  await expect(root.locator('img')).toHaveAttribute('src', 'https://cdn.example/file/x.png');
  expect(await md(page)).toBe('![a](/file/x.png)');
  await page.evaluate(() => (window as any).editor.setOptions({ attributes: {}, editable: false }));
  await expect(root).not.toHaveAttribute('autocorrect', 'on');
  await expect(root).toHaveAttribute('contenteditable', 'false');
  expect(await page.evaluate(() => (window as any).editor.commands.toggleBold())).toBe(false);
  await page.evaluate(() => (window as any).editor.setMarkdown(''));
  const placeholder = await root.evaluate((el) => getComputedStyle(el).getPropertyValue('--mbe-placeholder'));
  expect(placeholder).toBe('"New placeholder"');
  expect(await page.evaluate(() => (window as any).editor.isEmpty)).toBe(true);
});

test("setMarkdown with history: 'keep' can be undone", async ({ page }) => {
  await open(page, 'old');
  const result = await page.evaluate(() => {
    const editor = (window as any).editor;
    editor.setMarkdown('new', { history: 'keep' });
    const before = editor.getMarkdown();
    editor.commands.undo();
    return [before, editor.getMarkdown()];
  });
  expect(result).toEqual(['new', 'old']);
});
