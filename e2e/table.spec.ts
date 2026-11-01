import { expect, md, test } from './helpers';

test('typing GFM table markdown creates a table without escaping its delimiter', async ({ page }) => {
  await page.goto('/?md=');
  const editor = page.locator('#editor');
  await editor.click();
  await page.keyboard.type('| test | table | row |');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('| :--- | :--- | :--- |');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('| test | data | here |');

  await expect.poll(() => md(page)).toBe('| test | table | row |\n| :-- | :-- | :-- |\n| test | data | here |\n');
});
