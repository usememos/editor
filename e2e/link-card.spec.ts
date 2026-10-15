import { expect, md, test } from './helpers';

const card = (page: import('@playwright/test').Page) => page.locator('.mbe-link-card');

test.beforeEach(async ({ page, context }) => {
  // Do not leave the test sandbox: answer every request for the link page here.
  await context.route('https://example.com/**', (route) => route.fulfill({ body: 'docs' }));
  await page.goto(`/?md=${encodeURIComponent('see [the docs](https://example.com/docs) here\n')}`);
});

test('resting the pointer on a link shows its card with the URL; leaving hides it', async ({ page }) => {
  await page.locator('#editor a.mbe-link').hover();
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('.mbe-link-card-url')).toHaveText('https://example.com/docs');
  await expect(card(page).locator('button')).toHaveCount(4);
  // The card sits under the link.
  const linkBox = (await page.locator('#editor a.mbe-link').boundingBox())!;
  const cardBox = (await card(page).boundingBox())!;
  expect(cardBox.y).toBeGreaterThanOrEqual(linkBox.y + linkBox.height);
  // Moving from the link onto the card keeps it; moving away hides it.
  await card(page).hover();
  await expect(card(page)).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(card(page)).toBeHidden();
});

test('the caret inside a link shows the card, at its edges it does not', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.locator('p').click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  // At the start of the link: no card.
  await page.mouse.move(5, 5);
  await expect(card(page)).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('.mbe-link-card-url')).toHaveText('https://example.com/docs');
  // A text selection shows the formatting toolbar instead.
  await page.keyboard.press('Shift+ArrowRight');
  await expect(card(page)).toBeHidden();
  await expect(page.locator('.mbe-toolbar')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('End');
  await expect(card(page)).toBeHidden();
});

test('Edit opens the link field with the URL, and Enter saves the new one', async ({ page }) => {
  await page.locator('#editor a.mbe-link').hover();
  await card(page).getByRole('button', { name: 'Edit link' }).click();
  const input = page.locator('.mbe-popover-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('https://example.com/docs');
  await input.fill('https://example.com/guide');
  await input.press('Enter');
  expect(await md(page)).toBe('see [the docs](https://example.com/guide) here\n');
  // Focus is back in the editor.
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  expect(await md(page)).toBe('see [the docs](https://example.com/guide) here!\n');
});

test('Remove keeps the text, as one undo step, and leaves the caret where it was', async ({ page }) => {
  await page.locator('#editor p').click();
  await page.keyboard.press('End');
  const caret = await page.evaluate(() => (window as any).editor.selectionToJSON());
  await page.locator('#editor a.mbe-link').hover();
  await card(page).getByRole('button', { name: 'Remove link' }).click();
  expect(await md(page)).toBe('see the docs here\n');
  await expect(card(page)).toBeHidden();
  expect(await page.evaluate(() => (window as any).editor.selectionToJSON())).toEqual(caret);
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('see [the docs](https://example.com/docs) here\n');
});

test('Open and the URL open the link in a new tab; onLinkClick can take it', async ({ page, context }) => {
  await page.locator('#editor a.mbe-link').hover();
  const [opened] = await Promise.all([context.waitForEvent('page'), card(page).getByRole('button', { name: 'Open link' }).click()]);
  expect(opened.url()).toBe('https://example.com/docs');
  await opened.close();
  const [again] = await Promise.all([context.waitForEvent('page'), card(page).locator('.mbe-link-card-url').click()]);
  expect(again.url()).toBe('https://example.com/docs');
  await again.close();
  await page.evaluate(() => {
    const w = window as any;
    w.clicked = [];
    w.editor.setOptions({ onLinkClick: ({ href }: { href: string }) => (w.clicked.push(href), true) });
  });
  await card(page).getByRole('button', { name: 'Open link' }).click();
  expect(await page.evaluate(() => (window as any).clicked)).toEqual(['https://example.com/docs']);
  expect(context.pages()).toHaveLength(1);
});

test('Copy copies the URL as written', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Reading the clipboard needs Chromium permissions');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#editor a.mbe-link').hover();
  const copy = card(page).locator('.mbe-link-card-copyLink');
  await copy.click();
  await expect(copy).toHaveAttribute('aria-label', 'Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://example.com/docs');
});

test('no card while read-only, or with linkCard: false', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  await page.locator('#editor a.mbe-link').hover();
  await page.waitForTimeout(500);
  await expect(card(page)).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.editor.destroy();
    w.editor = new w.core.Editor({ element: document.getElementById('editor'), content: 'see [docs](https://example.com/docs)\n', linkCard: false });
  });
  await page.mouse.move(5, 5);
  await page.locator('#editor a.mbe-link').hover();
  await page.waitForTimeout(500);
  await expect(card(page)).toHaveCount(0);
});
