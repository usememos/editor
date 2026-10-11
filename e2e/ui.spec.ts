import { expect, test } from '@playwright/test';
import { blocks, md } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/?empty');
  await page.locator('#editor').click();
});

const slashMenu = (page: import('@playwright/test').Page) => page.locator('.mbe-slash-menu');

test('slash menu: opens, filters, picks with the keyboard', async ({ page }) => {
  await page.keyboard.type('/');
  await expect(slashMenu(page)).toBeVisible();
  await expect(slashMenu(page).locator('.mbe-menu-item')).toHaveCount(11);
  await page.keyboard.type('head');
  await expect(slashMenu(page).locator('.mbe-menu-item')).toHaveText([/Heading 1/, /Heading 2/, /Heading 3/]);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(slashMenu(page)).toBeHidden();
  await page.keyboard.type('Title');
  expect(await blocks(page)).toEqual(['h2:Title']);
});

test('slash menu: a late selectionchange keeps the highlighted item', async ({ page }) => {
  await page.keyboard.type('/head');
  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')));
  await page.keyboard.press('Enter');
  await page.keyboard.type('Title');
  expect(await blocks(page)).toEqual(['h2:Title']);
});

test('slash menu: aria wiring for screen readers', async ({ page }) => {
  await page.keyboard.type('/');
  const active = await page.locator('#editor').getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  await expect(page.locator(`#${active}`)).toHaveAttribute('aria-selected', 'true');
  await expect(slashMenu(page)).toHaveAttribute('role', 'listbox');
});

test('slash menu: Escape closes and keeps the text', async ({ page }) => {
  await page.keyboard.type('/quo');
  await page.keyboard.press('Escape');
  await expect(slashMenu(page)).toBeHidden();
  expect(await blocks(page)).toEqual(['p:/quo']);
});

test('slash menu: no results, and does not open inside a word', async ({ page }) => {
  await page.keyboard.type('/zz');
  await expect(slashMenu(page)).toContainText('No results');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('a/b');
  await expect(slashMenu(page)).toBeHidden();
});

test('slash menu: inserting a table below text, then typing in cells with Tab', async ({ page }) => {
  await page.keyboard.type('intro');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  expect(await blocks(page)).toEqual(['p:intro', 'table:||/||/||']);
  await page.keyboard.type('A');
  await page.keyboard.press('Tab');
  await page.keyboard.type('B');
  expect(await blocks(page)).toEqual(['p:intro', 'table:A|B|/||/||']);
  expect(await md(page)).toContain('| A | B |');
});

test('formatting toolbar: appears on selection and applies marks', async ({ page }) => {
  await page.keyboard.type('make this bold');
  const toolbar = page.locator('.mbe-toolbar');
  await expect(toolbar).toBeHidden();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
  await expect(toolbar).toBeVisible();
  await toolbar.locator('.mbe-tool-bold').click();
  expect(await md(page)).toBe('make this **bold**\n');
  await expect(toolbar.locator('.mbe-tool-bold')).toHaveAttribute('aria-pressed', 'true');
  // The selection survives the click.
  await page.keyboard.press('Control+i');
  expect(await md(page)).toBe('make this ***bold***\n');
  await page.keyboard.press('ArrowRight');
  await expect(toolbar).toBeHidden();
});

test('formatting toolbar: has only mark and link buttons', async ({ page }) => {
  await page.keyboard.type('format me');
  await page.keyboard.press('Shift+Home');
  const labels = await page.locator('.mbe-toolbar button').evaluateAll((els) => els.map((el) => el.textContent));
  expect(labels).toEqual(['B', 'I', 'S', '</>', 'Link']);
});

test('link: Ctrl+K on a selection, then edit and remove', async ({ page }) => {
  await page.keyboard.type('see docs');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Control+k');
  const input = page.locator('.mbe-link-input');
  await expect(input).toBeFocused();
  await input.fill('https://example.com');
  await input.press('Enter');
  expect(await md(page)).toBe('see [docs](https://example.com)\n');
  await expect(page.locator('#editor a.mbe-link')).toHaveAttribute('href', 'https://example.com');
  // Focus is back in the editor.
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  expect(await md(page)).toBe('see [docs](https://example.com)!\n');
});

test('link: pasting a URL over selected text', async ({ page }) => {
  await page.keyboard.type('click here');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'https://x.dev');
    document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  expect(await md(page)).toBe('click [here](https://x.dev)\n');
});

test('block handle: only tables and code blocks have it; the menu duplicates and deletes', async ({ page }) => {
  await page.keyboard.type('intro');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```js ');
  await page.keyboard.type('let a = 1;');
  const handle = page.locator('.mbe-handle');
  await page.locator('#editor p').first().hover();
  await page.waitForTimeout(400); // past the handle's hide delay
  await expect(handle).toBeHidden();
  await page.locator('#editor .mbe-code pre').hover();
  await expect(handle).toBeVisible();
  await handle.click();
  const menu = page.locator('.mbe-block-menu');
  await expect(menu.locator('.mbe-menu-item')).toHaveText([/Duplicate/, /Delete/]);
  await menu.locator('.mbe-menu-item', { hasText: 'Duplicate' }).click();
  expect(await blocks(page)).toEqual(['p:intro', 'code(js):let a = 1;', 'code(js):let a = 1;']);
  await page.locator('#editor .mbe-code pre').last().hover();
  await handle.click();
  await menu.locator('.mbe-menu-item', { hasText: 'Delete' }).click();
  expect(await blocks(page)).toEqual(['p:intro', 'code(js):let a = 1;']);
});

test('block menu with Ctrl+/: opens in a table cell, not in a paragraph', async ({ page }) => {
  await page.keyboard.type('item');
  await page.keyboard.press('Control+/');
  const menu = page.locator('.mbe-block-menu');
  await expect(menu).toBeHidden();
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A');
  await page.keyboard.press('Control+/');
  await expect(menu).toBeVisible();
  await menu.locator('.mbe-menu-item', { hasText: 'Add column right' }).click();
  expect(await blocks(page)).toEqual(['p:item', 'table:A|||/|||/|||']);
  await expect(menu).toBeHidden();
});

test('handle and toolbar never reach the saved Markdown or the clipboard', async ({ page }) => {
  await page.keyboard.type('plain');
  await page.locator('#editor p').hover();
  await page.keyboard.press('Control+a');
  const copied = await page.evaluate(() => {
    const data = new DataTransfer();
    document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return { text: data.getData('text/plain'), html: data.getData('text/html') };
  });
  expect(copied.text).toBe('plain');
  expect(copied.html).not.toContain('mbe-handle');
  expect(copied.html).not.toContain('mbe-toolbar');
});

test('placeholder shows only in an empty document', async ({ page }) => {
  const first = page.locator('#editor > p').first();
  const content = await first.evaluate((el) => getComputedStyle(el, '::before').content);
  expect(content).toContain('Write something');
  await page.keyboard.type('x');
  const after = await first.evaluate((el) => getComputedStyle(el, '::before').content);
  expect(after === 'none' || after === 'normal' || after === '""').toBe(true);
});
