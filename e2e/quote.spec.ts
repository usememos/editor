import { blocks, expect, md, test, viewProblems } from './helpers';

// A quote holding a paragraph and a list, as reported on usememos/memos#6479.
const DOC = 'Before.\n\n> ✏️ **quick note**\n> * Item 1: check xyz\n> * Item 2: check abc\n\nAfter.\n';

test.beforeEach(async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent(DOC)}`);
});

test('a list in a quote shows as list items inside one quote, and saves unchanged', async ({ page }) => {
  expect(await blocks(page)).toEqual(['p:Before.', 'quote:✏️ quick note', 'quote/ul0:Item 1: check xyz', 'quote/ul0:Item 2: check abc', 'p:After.']);
  const parts = page.locator('#editor > blockquote');
  await expect(parts).toHaveCount(3);
  await expect(parts.nth(1)).toHaveClass(/mbe-list-item/);
  // No raw source: the Markdown markers are not shown.
  await expect(page.locator('#editor')).not.toContainText('>');
  // One quote: the border runs unbroken from the paragraph through the list.
  const boxes = await parts.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom, left: r.left })));
  for (let i = 1; i < boxes.length; i++) {
    expect(Math.abs(boxes[i]!.top - boxes[i - 1]!.bottom)).toBeLessThan(1);
    expect(boxes[i]!.left).toBe(boxes[0]!.left);
  }
  const border = await parts.nth(1).evaluate((el) => getComputedStyle(el).borderInlineStartWidth);
  expect(border).toBe(await parts.first().evaluate((el) => getComputedStyle(el).borderInlineStartWidth));
  // The items sit as close as list items outside a quote.
  const [one, two] = [(await parts.nth(1).locator('.mbe-content').boundingBox())!, (await parts.nth(2).locator('.mbe-content').boundingBox())!];
  expect(two.y - (one.y + one.height)).toBeLessThan(6);
  expect(await md(page)).toBe(DOC);
  expect(await viewProblems(page)).toEqual([]);
});

test('read-only shows the same quote', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  await expect(page.locator('#editor > blockquote.mbe-list-item')).toHaveCount(2);
  await expect(page.locator('#editor')).not.toContainText('>');
});

test('typing "- " in a quote starts a list in it; Enter twice on an empty item leaves the list, then the quote', async ({ page }) => {
  await page.locator('#editor p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('> note');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('end');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('out');
  expect((await blocks(page)).slice(-5)).toEqual(['quote:note', 'quote/ul0:one', 'quote/ul0:two', 'quote:end', 'p:out']);
  expect(await md(page)).toBe(DOC + '\n> note\n>\n> - one\n> - two\n>\n> end\n\nout\n');
  expect(await viewProblems(page)).toEqual([]);
});

test('a list in a callout keeps one icon and one box', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent('> [!NOTE]\n> - one\n> - two\n>\n> Text.\n')}`);
  expect(await blocks(page)).toEqual(['note/ul0:one', 'note/ul0:two', 'note:Text.']);
  const parts = page.locator('#editor > blockquote[data-callout="note"]');
  await expect(parts).toHaveCount(3);
  await expect(parts.first().locator('.mbe-callout-icon')).toBeVisible();
  await expect(parts.nth(1).locator('.mbe-callout-icon')).toBeHidden();
  // The icon sits level with the first item.
  const icon = (await parts.first().locator('.mbe-callout-icon').boundingBox())!;
  const text = (await parts.first().locator('.mbe-content').boundingBox())!;
  expect(Math.abs(icon.y - text.y)).toBeLessThan(1);
  // Picking a type in the icon's menu changes the list too.
  await parts.first().locator('.mbe-callout-icon').click();
  await page.locator('.mbe-block-menu .mbe-menu-item', { hasText: 'Tip' }).click();
  expect(await blocks(page)).toEqual(['tip/ul0:one', 'tip/ul0:two', 'tip:Text.']);
});

test('a quote the editor cannot hold as blocks shows rendered, and its source when clicked', async ({ page }) => {
  const doc = 'Before.\n\n> [!WARNING]\n> Run this first:\n> ```\n> rm -rf build\n> ```\n> - then this\n\n- Step\n\n  Second paragraph.\n';
  await page.goto(`/?md=${encodeURIComponent(doc)}`);
  const raw = page.locator('#editor > .mbe-raw[data-syntax="markdown"]');
  await expect(raw).toHaveCount(2);
  // Rendered with the editor's blocks: a callout box around a code block and a list, and a list item holding two paragraphs.
  await expect(raw.first()).toHaveClass(/mbe-view-block/);
  await expect(raw.first().locator('blockquote[data-callout="warning"] .mbe-callout-icon')).toBeVisible();
  await expect(raw.first().locator('blockquote .mbe-code code')).toHaveText('rm -rf build');
  await expect(raw.first().locator('blockquote .mbe-list-item')).toHaveText('then this');
  await expect(raw.nth(1).locator('.mbe-list-item p')).toHaveText(['Step', 'Second paragraph.']);
  await expect(page.locator('#editor')).not.toContainText('[!WARNING]');
  // Nothing in it is a block of the document.
  await expect(raw.first().locator('[data-block-id]')).toHaveCount(0);
  // A click shows the source, as plain text to edit.
  await raw.first().click();
  await expect(page.locator('#editor > pre.mbe-raw[data-syntax="markdown"]')).toHaveText('> [!WARNING]\n> Run this first:\n> ```\n> rm -rf build\n> ```\n> - then this');
  // Read-only always shows it rendered.
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  await expect(page.locator('#editor > pre.mbe-raw')).toHaveCount(0);
  await expect(raw).toHaveCount(2);
  expect(await md(page)).toBe(doc);
});
