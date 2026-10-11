import { expect, test } from '@playwright/test';

test('React comment box: controlled value, Mod+Enter posts and clears', async ({ page }) => {
  await page.goto('/react.html');
  const editor = page.locator('.comment .mbe-root');
  await editor.click();
  await page.keyboard.type('Looks **good**');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- ship it');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('#posted li')).toHaveText(['Looks **good**\n\n- ship it\n']);
  // The parent cleared the value; the editor follows.
  await expect(editor).toHaveText('');
  await page.keyboard.type('next');
  await expect(editor).toHaveText('next');
});
