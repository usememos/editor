import { expect, test } from './helpers';

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

test('React: placeholder and editable update live; outside values replace the document', async ({ page }) => {
  await page.goto('/react.html?demo=api');
  const root = page.locator('#controlled .mbe-root');
  await expect(root).toHaveText('start');
  await page.locator('#set-outside').click();
  await expect(root).toHaveText('from outside');
  await page.locator('#clear').click();
  await expect(root).toHaveText('');
  const placeholder = () => root.evaluate((el) => getComputedStyle(el).getPropertyValue('--mbe-placeholder'));
  expect(await placeholder()).toBe('"First placeholder"');
  await page.locator('#placeholder').click();
  await expect.poll(placeholder).toBe('"Second placeholder"');
  await page.locator('#editable').click();
  await expect(root).toHaveAttribute('contenteditable', 'false');
  await page.locator('#editable').click();
  await expect(root).toHaveAttribute('contenteditable', 'true');
  await root.click();
  await page.keyboard.type('typed');
  await expect(page.locator('#value')).toHaveText('typed\n');
});

test('React: an outside value during IME composition waits for the composition to end', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'IME is simulated through the Chrome DevTools Protocol');
  await page.goto('/react.html?demo=api');
  const root = page.locator('#controlled .mbe-root');
  await root.click();
  await page.keyboard.press('End');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  // The parent sets a value while the user is composing.
  await page.evaluate(() => (document.querySelector('#set-outside') as HTMLButtonElement).click());
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await expect(root).toHaveText('startに');
  await cdp.send('Input.insertText', { text: 'に' });
  await expect(root).toHaveText('from outside');
});

test('React: useEditor and EditorContent', async ({ page }) => {
  await page.goto('/react.html?demo=api');
  const root = page.locator('#hook .mbe-root');
  await expect(root).toHaveText('From useEditor');
  // autofocus: 'end' puts the caret at the end once the editor is mounted.
  await page.keyboard.type('!');
  await expect(page.locator('#hook-output')).toHaveText('# From useEditor!\n');
});
