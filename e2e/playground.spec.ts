// Smoke test of the playground composer, which uses only the public API.

import { expect, test } from '@playwright/test';
import { md } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('playground: tags, formatting bar, image upload, caret restore, submit', async ({ page }) => {
  const editor = page.locator('#editor');
  await page.evaluate(() => (window as any).editor.setMarkdown(''));
  await editor.click();
  await page.keyboard.type('Plan #wo');
  await page.locator('.mbe-suggestion-menu .mbe-menu-item', { hasText: '#work/planning' }).click();
  await page.keyboard.type('today');
  await expect(editor.locator('.tag')).toHaveText(['#work/planning']);
  expect(await md(page)).toBe('Plan #work/planning today\n');

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
  expect(await md(page)).toMatch(/^## Plan #work\/planning today\n\n!\[shot\.png\]\(blob:/);

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
  await expect(page.locator('#saved li')).toHaveCount(1);
  expect(await md(page)).toBe('');
});

test('editing and read-only look the same', async ({ page }) => {
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    el?.blur();
  });
  const editor = page.locator('#editor');
  // The sample has every block type: headings, lists, tasks, quote, math, code, table, divider.
  const editing = await editor.screenshot({ animations: 'disabled' });
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  const readOnly = await editor.screenshot({ animations: 'disabled' });
  expect(readOnly.equals(editing)).toBe(true);
});

test('block spacing: one gap between blocks, close list items, joined quotes', async ({ page }) => {
  const gaps = async () =>
    page.evaluate(() => {
      const els = Array.from(document.querySelectorAll<HTMLElement>('#editor > .mbe-block'));
      return els.slice(1).map((el, i) => Math.round(el.getBoundingClientRect().top - els[i]!.getBoundingClientRect().bottom));
    });
  await page.evaluate(() => (window as any).editor.setMarkdown('## Title\n\none\n\n- a\n- b\n\n1. c\n\n> d\n>\n> e\n\ntwo\n\n---\n\nthree'));
  // h2→p, p→li, li→li, bullet→numbered list, li→quote, quote→quote, quote→p, p→hr, hr→p
  expect(await gaps()).toEqual([8, 8, 2, 8, 8, 0, 8, 16, 16]);
  // Marks follow edits: a paragraph between two items splits one list into two.
  await page.evaluate(() => {
    const editor = (window as any).editor;
    editor.setMarkdown('- a\n- b\n- c');
    editor.setSelection({ anchor: { block: 1, offset: 0 }, focus: { block: 1, offset: 0 } });
    editor.commands.toggleBulletList();
  });
  expect(await gaps()).toEqual([8, 8]);
  await page.evaluate(() => (window as any).editor.commands.toggleBulletList());
  expect(await gaps()).toEqual([2, 2]);
});
