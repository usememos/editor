// The syntax spec (docs/syntax.md) in the browser: tags, mentions,
// escapes, suggestion menus and autolink literals as typed with a keyboard.

import { blocks, expect, md, test } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(() => {
    const { Editor, tags, mentions, suggestion } = (window as any).core;
    (window as any).editor.destroy();
    (window as any).editor = new Editor({
      element: document.getElementById('editor'),
      extensions: [
        tags(),
        mentions(),
        suggestion({
          name: 'tags',
          trigger: '#',
          className: 'tag-menu',
          items: ({ query }: { query: string }) => ['work', 'reading'].filter((t) => t.startsWith(query)).map((t) => ({ id: t, label: `#${t}` })),
        }),
      ],
    });
  });
  await page.locator('#editor').click();
});

test('tags and mentions highlight as typed, but not in URLs, e-mail addresses or after a letter', async ({ page }) => {
  await page.keyboard.type('Plan #work/q1 with @alice, see https://x.com/#anchor and mail bob@example.com C# ');
  await expect(page.locator('#editor .mbe-tag')).toHaveText(['#work/q1']);
  await expect(page.locator('#editor .mbe-mention')).toHaveText(['@alice']);
  await expect(page.locator('#editor a')).toHaveText(['https://x.com/#anchor', 'bob@example.com']);
  expect(await md(page)).toBe('Plan #work/q1 with @alice, see https://x.com/#anchor and mail bob@example.com C#&#32;\n');
});

test('a typed \\# is an escape: saved as written and never a tag', async ({ page }) => {
  await page.keyboard.type('\\#not-a-tag #real');
  await expect(page.locator('#editor .mbe-tag')).toHaveText(['#real']);
  await expect(page.locator('#editor .mbe-token-escape')).toHaveText(['\\#']);
  expect(await md(page)).toBe('\\#not-a-tag #real\n');
  // Loading it again keeps the escape.
  await page.evaluate(() => (window as any).editor.setMarkdown('\\#x and \\@y'));
  await expect(page.locator('#editor .mbe-tag')).toHaveCount(0);
  await expect(page.locator('#editor .mbe-mention')).toHaveCount(0);
  expect(await md(page)).toBe('\\#x and \\@y');
});

test('the # menu opens at the start of a block and after a space only', async ({ page }) => {
  const menu = page.locator('.tag-menu');
  await page.keyboard.type('a#');
  await expect(menu).toBeHidden();
  await page.keyboard.type(' #w');
  await expect(menu.locator('.mbe-menu-item')).toHaveText(['#work']);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  expect(await md(page)).toBe('a# #work&#32;\n');
});

test('# then a space at the start of a paragraph makes a heading, and the menu closes', async ({ page }) => {
  const menu = page.locator('.tag-menu');
  await page.keyboard.type('#');
  await expect(menu).toBeVisible();
  await page.keyboard.type(' Title');
  await expect(menu).toBeHidden();
  await page.keyboard.type(' #work ');
  expect(await blocks(page)).toEqual(['h1:Title #work ']);
  await expect(page.locator('#editor .mbe-tag')).toHaveText(['#work']);
});

test('the # menu does not open in code blocks, but does in table cells', async ({ page }) => {
  const menu = page.locator('.tag-menu');
  await page.evaluate(() => (window as any).editor.setMarkdown('```\ncode\n```\n\n| a |\n| - |\n| b |'));
  await page.locator('#editor pre code').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' #w');
  await expect(menu).toBeHidden();
  await page.locator('#editor td').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' #w');
  await expect(menu.locator('.mbe-menu-item')).toHaveText(['#work']);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  expect(await blocks(page)).toEqual(['code():code #w', 'table:a/b #work ']);
  await expect(page.locator('#editor td .mbe-tag')).toHaveText(['#work']);
  await expect(page.locator('#editor pre .mbe-tag')).toHaveCount(0);
});

test('a typed URL becomes a link on space, and undo restores the text', async ({ page }) => {
  await page.keyboard.type('see www.example.com/a. ');
  await expect(page.locator('#editor a')).toHaveText(['www.example.com/a']);
  await page.keyboard.type('now');
  expect(await md(page)).toBe('see www.example.com/a. now\n');
  await page.keyboard.press('Control+z'); // typing "now"
  await page.keyboard.press('Control+z');
  await expect(page.locator('#editor a')).toHaveCount(0);
  expect(await blocks(page)).toEqual(['p:see www.example.com/a. ']);
});
