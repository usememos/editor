// :emoji autocomplete from @usememos/editor/emoji, as the playground sets it up.

import { expect, md, test } from './helpers';

const menu = (page: import('@playwright/test').Page) => page.locator('.mbe-emoji-menu');

test.beforeEach(async ({ page }) => {
  await page.goto('/?empty');
  await page.locator('#editor').click();
});

test('typing :ta lists emoji by name, and a pick writes the emoji and a space', async ({ page }) => {
  await page.keyboard.type('Shipped :tad');
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).locator('.mbe-menu-item').first()).toContainText(':tada:');
  await expect(menu(page).locator('.mbe-menu-item').first().locator('.mbe-menu-icon')).toHaveText('🎉');
  await page.keyboard.press('Enter');
  await expect(menu(page)).toBeHidden();
  await page.keyboard.type('today');
  expect(await md(page)).toBe('Shipped 🎉 today\n');
  // One undo takes the pick back to what was typed.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('Shipped :tad\n');
});

test('tags find emoji too, and no space is added before punctuation', async ({ page }) => {
  await page.keyboard.type('!');
  await page.keyboard.press('Home');
  await page.keyboard.type('Nice :hooray');
  // "hooray" is a tag of 🙌 and 🎉, not a name.
  await expect(menu(page).locator('.mbe-menu-icon')).toContainText(['🙌', '🎉']);
  await menu(page).locator('.mbe-menu-item', { hasText: ':tada:' }).click();
  expect(await md(page)).toBe('Nice 🎉!\n');
});

test('stays closed for one letter, a colon inside a word, emoticons and code', async ({ page }) => {
  for (const text of ['a :b', 'time 10:30', 'Note: done', 'smile :)', 'code `:tada']) {
    await page.evaluate(() => (window as any).editor.setMarkdown(''));
    await page.keyboard.type(text);
    await page.waitForTimeout(100);
    await expect(menu(page)).toHaveCount(0);
  }
});

test('Escape closes it and leaves the text', async ({ page }) => {
  await page.keyboard.type(':rocket');
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toBeHidden();
  expect(await md(page)).toBe(':rocket\n');
});

test('a pick with the caret inside a name replaces the whole name', async ({ page }) => {
  await page.keyboard.type(':rocke');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('c');
  // The query is ":roc", the text before the caret; the pick replaces all of ":rocke".
  await menu(page).locator('.mbe-menu-item', { hasText: ':rocket:' }).click();
  expect(await md(page)).toBe('🚀\n');
});
