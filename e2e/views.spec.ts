// Rendered views: math shows as formulas, and its source shows at the caret.

import { expect, test } from '@playwright/test';
import { md } from './helpers';

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
