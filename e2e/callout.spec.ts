import { blocks, expect, md, test, viewProblems } from './helpers';

const DOC = 'Before.\n\n> [!NOTE]\n> One.\n>\n> Two.\n\n> [!WARNING]\n> Careful.\n\nAfter.\n';
const menu = (page: import('@playwright/test').Page) => page.locator('.mbe-block-menu');

test.beforeEach(async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent(DOC)}`);
});

test('a GitHub alert shows as a tinted callout with one icon, and saves unchanged', async ({ page }) => {
  expect(await blocks(page)).toEqual(['p:Before.', 'note:One.', 'note:Two.', 'warning:Careful.', 'p:After.']);
  const note = page.locator('#editor > blockquote[data-callout="note"]');
  await expect(note).toHaveCount(2);
  // The icon shows on the first paragraph only, and is labelled with the type.
  await expect(note.first().locator('.mbe-callout-icon')).toBeVisible();
  await expect(note.first().locator('.mbe-callout-icon')).toHaveAccessibleName('Note');
  await expect(note.first().locator('.mbe-callout-icon')).toHaveText('');
  await expect(note.nth(1).locator('.mbe-callout-icon')).toBeHidden();
  await expect(page.locator('#editor > blockquote[data-callout="warning"] .mbe-callout-icon')).toHaveAccessibleName('Warning');
  // A tinted box with no border: the tint and the icon's color differ between types, and the text keeps the body color.
  const style = (type: string, sel = '') =>
    page.locator(`#editor > blockquote[data-callout="${type}"] ${sel}`).first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor, border: s.borderInlineStartWidth, radius: [s.borderTopLeftRadius, s.borderBottomLeftRadius] };
    });
  const [noteBox, warningBox] = [await style('note'), await style('warning')];
  expect(noteBox.border).toBe('0px');
  expect(noteBox.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(noteBox.background).not.toBe(warningBox.background);
  expect(noteBox.color).toBe(await page.locator('#editor > p').first().evaluate((el) => getComputedStyle(el).color));
  expect((await style('note', '.mbe-callout-icon')).color).not.toBe((await style('warning', '.mbe-callout-icon')).color);
  // One box: the paragraphs touch, and only its outer corners are rounded.
  const [first, second] = [(await note.first().boundingBox())!, (await note.nth(1).boundingBox())!];
  expect(Math.abs(first.y + first.height - second.y)).toBeLessThan(1);
  expect(noteBox.radius[0]).not.toBe('0px');
  expect(noteBox.radius[1]).toBe('0px');
  expect((await note.nth(1).evaluate((el) => getComputedStyle(el).borderTopLeftRadius))).toBe('0px');
  // The icon sits level with the first line of text.
  const icon = (await note.first().locator('.mbe-callout-icon').boundingBox())!;
  const text = (await note.first().locator('.mbe-content').boundingBox())!;
  expect(icon.x + icon.width).toBeLessThanOrEqual(text.x);
  expect(Math.abs(icon.y - text.y)).toBeLessThan(1);
  expect(await md(page)).toBe(DOC);
});

test('the slash menu makes a callout; Enter adds a line to it, and Enter on an empty line ends it', async ({ page }) => {
  await page.locator('#editor p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/callout');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Tip one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('out');
  expect((await blocks(page)).slice(-3)).toEqual(['note:Tip one', 'note:two', 'p:out']);
  expect(await md(page)).toBe(DOC + '\n> [!NOTE]\n> Tip one\n>\n> two\n\nout\n');
  expect(await viewProblems(page)).toEqual([]);
});

test('typing a marker in a quote makes the whole quote a callout', async ({ page }) => {
  await page.locator('#editor p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('> first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Home');
  await page.keyboard.type('[!tip] ');
  expect((await blocks(page)).slice(-2)).toEqual(['tip:first', 'tip:second']);
  // Backspace right after it takes back the conversion and leaves the typed marker.
  await page.keyboard.press('Backspace');
  expect((await blocks(page)).slice(-2)).toEqual(['quote:[!tip] first', 'quote:second']);
});

test('clicking the icon opens the type menu; a pick changes the whole callout in one undo step', async ({ page }) => {
  await page.locator('#editor > blockquote[data-callout="note"] .mbe-callout-icon').first().click();
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).locator('.mbe-menu-item')).toHaveText([/Note/, /Tip/, /Important/, /Warning/, /Caution/, /Delete/]);
  await expect(menu(page).locator('.mbe-menu-item', { hasText: 'Note' })).toHaveAttribute('aria-checked', 'true');
  await menu(page).locator('.mbe-menu-item', { hasText: 'Caution' }).click();
  await expect(menu(page)).toBeHidden();
  expect(await blocks(page)).toEqual(['p:Before.', 'caution:One.', 'caution:Two.', 'warning:Careful.', 'p:After.']);
  expect(await md(page)).toBe(DOC.replace('[!NOTE]', '[!CAUTION]'));
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe(DOC);
});

test('Ctrl+/ in a callout opens its menu; Delete removes the whole callout', async ({ page }) => {
  await page.locator('#editor > blockquote[data-callout="note"]').nth(1).locator('.mbe-content').click();
  await page.keyboard.press('Control+/');
  await expect(menu(page)).toBeVisible();
  await menu(page).locator('.mbe-menu-item', { hasText: 'Delete' }).click();
  expect(await blocks(page)).toEqual(['p:Before.', 'warning:Careful.', 'p:After.']);
});

test('the block handle sits by the icon of the hovered callout', async ({ page }) => {
  await page.locator('#editor > blockquote[data-callout="note"]').nth(1).hover();
  const handle = page.locator('.mbe-block-handle');
  await expect(handle).toBeVisible();
  const icon = (await page.locator('#editor > blockquote[data-callout="note"] .mbe-callout-icon').first().boundingBox())!;
  const box = (await handle.boundingBox())!;
  expect(Math.abs(box.y + box.height / 2 - (icon.y + icon.height / 2))).toBeLessThan(4);
});

test('arrow keys move between the text above and the callout, past its icon', async ({ page }) => {
  await page.locator('#editor p').first().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('x');
  expect(await blocks(page)).toEqual(['p:Before.', 'note:xOne.', 'note:Two.', 'warning:Careful.', 'p:After.']);
  // And back up, past the icon, to the paragraph above.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('y');
  expect((await blocks(page))[0]).toMatch(/^p:.*y/);
  expect(await viewProblems(page)).toEqual([]);
});

test('read-only shows the icons; clicking one opens nothing', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  const icon = page.locator('#editor > blockquote[data-callout="note"] .mbe-callout-icon').first();
  await expect(icon).toBeVisible();
  await icon.click();
  await expect(menu(page)).toBeHidden();
});

test('the API reads and changes callouts', async ({ page }) => {
  await page.locator('#editor > blockquote[data-callout="warning"] .mbe-content').click();
  const api = () =>
    page.evaluate(() => {
      const e = (window as any).editor;
      return [e.isActive('blockquote'), e.getAttributes('blockquote'), e.isActive('blockquote', { callout: 'warning' })];
    });
  // The model reads the click's caret on selectionchange, which can come after the click returns.
  await expect.poll(api).toEqual([true, { callout: 'warning' }, true]);
  await page.evaluate(() => (window as any).editor.commands.setCallout({ type: 'important' }));
  expect(await blocks(page)).toContain('important:Careful.');
  await page.evaluate(() => (window as any).editor.commands.setCallout({ type: null }));
  expect(await blocks(page)).toContain('quote:Careful.');
  await page.evaluate(() => (window as any).editor.commands.toggleCallout({ type: 'tip' }));
  expect(await blocks(page)).toContain('tip:Careful.');
  await page.evaluate(() => (window as any).editor.commands.toggleCallout({ type: 'tip' }));
  expect(await blocks(page)).toContain('p:Careful.');
});
