import { expect, test } from '@playwright/test';
import { blocks, md } from './helpers';

test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'IME is simulated through the Chrome DevTools Protocol');
  await page.goto('/?empty');
  await page.locator('#editor').click();
});

// IME input goes through a separate DevTools session, which is not ordered
// with Playwright's own keyboard events. Wait for a rendered frame before each
// step so earlier key presses have been handled, as they would be with a person typing.
async function frame(page: import('@playwright/test').Page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}

async function compose(page: import('@playwright/test').Page, steps: string[], commit: string) {
  const cdp = await page.context().newCDPSession(page);
  for (const text of steps) {
    await frame(page);
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  await frame(page);
  await cdp.send('Input.insertText', { text: commit });
  await frame(page);
}

test('composition is applied to the model on compositionend, as one undo step', async ({ page }) => {
  await page.keyboard.type('Say ');
  await compose(page, ['k', 'こ', 'こんにちは'], 'こんにちは');
  expect(await md(page)).toBe('Say こんにちは\n');
  await page.keyboard.type('!');
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('Say こんにちは\n');
});

test('composition inside bold text keeps the mark', async ({ page }) => {
  await page.keyboard.press('Control+b');
  await page.keyboard.type('ab');
  await page.keyboard.press('ArrowLeft');
  await compose(page, ['한'], '한');
  expect(await md(page)).toBe('**a한b**\n');
});

test('composition over a selection spanning blocks', async ({ page }) => {
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Shift+ArrowUp');
  await compose(page, ['中'], '中');
  expect(await md(page)).toBe('one中\n');
  await expect(page.locator('#editor > *')).toHaveCount(1);
});

test('composition starting in an empty block', async ({ page }) => {
  await page.keyboard.press('Enter');
  await compose(page, ['ni', '你'], '你好');
  expect(await blocks(page)).toEqual(['p:', 'p:你好']);
});

test('composition in a list item and in a table cell', async ({ page }) => {
  await page.keyboard.type('- ');
  await compose(page, ['に'], 'にほん');
  expect(await blocks(page)).toEqual(['ul0:にほん']);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await compose(page, ['表'], '表');
  expect((await blocks(page))[1]).toBe('table:表||/||/||');
});

test('a full-width slash from a Japanese IME opens the slash menu', async ({ page }) => {
  await compose(page, ['／'], '／');
  await expect(page.locator('.mbe-slash-menu')).toBeVisible();
});
