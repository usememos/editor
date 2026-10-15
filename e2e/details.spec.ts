import { blocks, expect, md, test, viewProblems } from './helpers';

const DOC = 'Before.\n\n<details>\n<summary>Closed</summary>\n\nHidden.\n\n</details>\n\n<details open>\n<summary>Open</summary>\n\nShown.\n\n</details>\n\nAfter.\n';
const section = (page: import('@playwright/test').Page, title: string) => page.locator('#editor > .mbe-details', { hasText: title });
const toggle = (page: import('@playwright/test').Page, title: string) => section(page, title).locator('.mbe-details-toggle');

test.beforeEach(async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent(DOC)}`);
});

test('<details> shows as a section: collapsed unless saved open, and saves unchanged', async ({ page }) => {
  expect(await blocks(page)).toEqual(['p:Before.', 'details:Closed', 'p:Hidden.', '/details', 'details:Open', 'p:Shown.', '/details', 'p:After.']);
  await expect(page.locator('#editor p', { hasText: 'Hidden.' })).toBeHidden();
  await expect(page.locator('#editor p', { hasText: 'Shown.' })).toBeVisible();
  await expect(toggle(page, 'Closed')).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle(page, 'Open')).toHaveAttribute('aria-expanded', 'true');
  // The blocks inside are indented under the title text.
  const title = await section(page, 'Open').locator('.mbe-content').boundingBox();
  const body = await page.locator('#editor p', { hasText: 'Shown.' }).boundingBox();
  expect(Math.abs(body!.x - title!.x)).toBeLessThan(2);
  expect(await md(page)).toBe(DOC);
});

test('the toggle collapses and expands a section without changing the Markdown', async ({ page }) => {
  await toggle(page, 'Closed').click();
  await expect(page.locator('#editor p', { hasText: 'Hidden.' })).toBeVisible();
  await expect(toggle(page, 'Closed')).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle(page, 'Closed')).toHaveAttribute('aria-label', 'Collapse');
  await toggle(page, 'Open').click();
  await expect(page.locator('#editor p', { hasText: 'Shown.' })).toBeHidden();
  expect(await md(page)).toBe(DOC);
  expect(await viewProblems(page)).toEqual([]);
});

test('the toggle works in read-only mode', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  await toggle(page, 'Closed').click();
  await expect(page.locator('#editor p', { hasText: 'Hidden.' })).toBeVisible();
});

test('the slash menu makes a section; Enter in the title goes to the body, and Enter on an empty last line leaves it', async ({ page }) => {
  await page.locator('#editor p', { hasText: 'After.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/collapsible');
  await page.keyboard.press('Enter');
  // An empty title shows its hint.
  await expect(page.locator('#editor > .mbe-details').last()).toHaveAttribute('data-hint', 'Title');
  await page.keyboard.type('Steps');
  await page.keyboard.press('Enter');
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('out');
  expect((await blocks(page)).slice(-4)).toEqual(['details:Steps', 'p:one', '/details', 'p:out']);
  expect(await md(page)).toBe(DOC + '\n<details>\n<summary>Steps</summary>\n\none\n\n</details>\n\nout\n');
  expect(await viewProblems(page)).toEqual([]);
});

test('">>> " and Mod+Shift+6 make a section, and Mod+Shift+6 on a title removes it', async ({ page }) => {
  await page.locator('#editor p', { hasText: 'After.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('>>> Typed');
  expect((await blocks(page)).slice(-3)).toEqual(['details:Typed', 'p:', '/details']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('Keyed');
  await page.keyboard.press('Control+Shift+6');
  expect((await blocks(page)).slice(-5)).toEqual(['details:Typed', 'details:Keyed', 'p:', '/details', '/details']);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Control+Shift+6');
  expect((await blocks(page)).slice(-4)).toEqual(['details:Typed', 'p:Keyed', 'p:', '/details']);
  expect(await viewProblems(page)).toEqual([]);
});

test('arrow keys skip a collapsed section; Enter in its title adds a line after it', async ({ page }) => {
  await section(page, 'Closed').locator('.mbe-content').click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('!');
  expect((await blocks(page))[4]).toBe('details:Open!');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('End');
  await page.keyboard.type('?');
  expect((await blocks(page))[1]).toBe('details:Closed?');
  await page.keyboard.press('Enter');
  await page.keyboard.type('next');
  expect((await blocks(page)).slice(0, 5)).toEqual(['p:Before.', 'details:Closed?', 'p:Hidden.', '/details', 'p:next']);
  await expect(page.locator('#editor p', { hasText: 'Hidden.' })).toBeHidden();
  expect(await viewProblems(page)).toEqual([]);
});

test('a caret moved into a collapsed section expands it', async ({ page }) => {
  await page.locator('#editor p', { hasText: 'Before.' }).click();
  await page.evaluate(() => {
    const editor = (window as any).editor;
    const hidden = editor.state.doc.blocks[2];
    editor.setSelection({ anchor: { blockId: hidden.id, offset: 0 }, focus: { blockId: hidden.id, offset: 0 } });
  });
  await expect(page.locator('#editor p', { hasText: 'Hidden.' })).toBeVisible();
  await expect(toggle(page, 'Closed')).toHaveAttribute('aria-expanded', 'true');
});

test('Backspace at the start of the line after a section goes to the end of its last line', async ({ page }) => {
  await page.locator('#editor p', { hasText: 'After.' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('+');
  expect((await blocks(page)).slice(-3)).toEqual(['p:Shown.+', '/details', 'p:After.']);
});

test('a block selection takes a section whole: copied, it pastes as a section', async ({ page }) => {
  await section(page, 'Closed').locator('.mbe-content').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#editor .mbe-block-selected')).toHaveCount(3);
  await page.keyboard.press('Control+c');
  // Arrow keys pass over the hidden blocks.
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => (window as any).editor.selectedBlocks.map((b: any) => b.type))).toEqual(['details', 'paragraph', 'detailsEnd']);
  await page.locator('#editor p', { hasText: 'After.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+v');
  expect((await blocks(page)).slice(-4)).toEqual(['details:Closed', 'p:Hidden.', '/details', 'p:']);
});
