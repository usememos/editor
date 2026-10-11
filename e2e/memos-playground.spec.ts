// Smoke test of the memos-style playground, which uses only the public API.

import { expect, test } from '@playwright/test';
import { md } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/memos.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('memos playground: tags, formatting bar, image upload, caret restore, submit', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.click();
  await page.keyboard.type('Plan #wo');
  await page.locator('.mbe-suggestion-menu .mbe-menu-item', { hasText: '#work/project' }).click();
  await page.keyboard.type('today');
  await expect(editor.locator('.tag')).toHaveText(['#work/project']);
  expect(await md(page)).toBe('Plan #work/project today\n');

  // The bar shows the active format at the caret.
  await page.locator('#bar button', { hasText: 'H2' }).click();
  await expect(page.locator('#bar button', { hasText: 'H2' })).toHaveClass(/on/);

  // A pasted image shows an upload placeholder, then becomes Markdown.
  await page.keyboard.press('End');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'shot.png', { type: 'image/png' }));
    document.querySelector('#editor h2')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator('.mbe-widget .upload')).toBeVisible();
  await expect(editor.locator('.mbe-widget')).toHaveCount(0, { timeout: 5000 });
  expect(await md(page)).toMatch(/^## Plan #work\/project today\n\n!\[shot\.png\]\(blob:/);

  // The draft and the caret survive a reload.
  await page.locator('#editor h2').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await page.reload();
  expect(await page.evaluate(() => (window as any).editor.selectionToJSON())).toEqual({
    anchor: { block: 0, offset: 1 },
    focus: { block: 0, offset: 1 },
  });

  await editor.click();
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('#memos li')).toHaveCount(1);
  expect(await md(page)).toBe('');
});
