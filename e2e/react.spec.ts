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

test('React: an app-drawn suggestion popup with useSuggestion, and items that change live', async ({ page }) => {
  await page.goto('/react.html?demo=suggest');
  const root = page.locator('#suggest .mbe-root');
  const popup = page.locator('.people-popup');
  await root.click();
  await page.keyboard.type('Hi @a');
  await expect(popup.locator('[role="option"]')).toHaveText(['Ada Lovelace', 'Alan Turing']);
  // No built-in popup is drawn.
  await expect(page.locator('.mbe-suggestion-menu')).toHaveCount(0);
  // The root points at the app's listbox and highlighted option.
  await expect(root).toHaveAttribute('aria-controls', (await popup.getAttribute('id'))!);
  await page.keyboard.press('ArrowDown');
  await expect(popup.locator('[aria-selected="true"]')).toHaveText('Alan Turing');
  await expect(root).toHaveAttribute('aria-activedescendant', (await popup.locator('[aria-selected="true"]').getAttribute('id'))!);
  // The popup sits under the trigger.
  const at = await page.evaluate(() => {
    const popup = document.querySelector('.people-popup')!.getBoundingClientRect();
    return popup.left;
  });
  const trigger = await root.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode() as Text;
    while (!text.data.includes('@')) text = walker.nextNode() as Text;
    const range = document.createRange();
    range.setStart(text, text.data.indexOf('@'));
    range.setEnd(text, text.data.indexOf('@') + 1);
    return range.getBoundingClientRect().left;
  });
  expect(Math.abs(at - trigger)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Enter');
  await expect(popup).toHaveCount(0);
  await expect(root).toHaveText('Hi @alan ');
  // New items from a re-render are used on the next query, without recreating the editor.
  await page.locator('#add-person').click();
  await root.click();
  await page.keyboard.press('End');
  await page.keyboard.type('@');
  await expect(popup.locator('[role="option"]')).toHaveText(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
  await popup.locator('[role="option"]', { hasText: 'Grace Hopper' }).click();
  await expect(root).toHaveText('Hi @alan @grace ');
  await expect(root).not.toHaveAttribute('aria-controls');
});
