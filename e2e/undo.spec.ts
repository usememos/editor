// Undo and redo for each kind of change a person makes: each is one step,
// undo puts the caret back where it was, and redo applies the change again.

import { blocks, expect, md, type Page, test } from './helpers';

const open = (page: Page, markdown: string) => page.goto(`/?md=${encodeURIComponent(markdown)}`);
const selection = (page: Page) =>
  page.evaluate(() => JSON.stringify((window as any).editor.selectionToJSON()));

const paste = (page: Page, text: string) =>
  page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.activeElement!.dispatchEvent((window as any).clipboardEvent('paste', data));
  }, text);

const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
const nothing = async () => {};

// [name, document, what to do before the change (such as selecting), the change]
const CASES: [string, string, (page: Page) => Promise<unknown>, (page: Page) => Promise<unknown>][] = [
  ['bold from the toolbar', 'make this bold\n', (page) => page.keyboard.press('Shift+Home'), (page) => page.locator('.mbe-toolbar .mbe-tool-bold').click()],
  ['a slash menu conversion', 'title\n', (page) => page.keyboard.type(' /h1'), (page) => page.keyboard.press('Enter')],
  ['a heading shortcut key', 'title\n', nothing, (page) => page.keyboard.press('Control+Alt+2')],
  ['Tab in a list', '- a\n- b\n', nothing, (page) => page.keyboard.press('Tab')],
  ['Enter in the middle of a block', 'split here\n', (page) => page.keyboard.press('ArrowLeft'), (page) => page.keyboard.press('Enter')],
  ['Backspace joining two blocks', 'one\n\ntwo\n', (page) => page.keyboard.press('Home'), (page) => page.keyboard.press('Backspace')],
  ['a pasted list', 'text\n', nothing, (page) => paste(page, '- pasted\n- items')],
  ['deleting selected blocks', 'one\n\ntwo\n', (page) => page.keyboard.press('Escape'), (page) => page.keyboard.press('Backspace')],
  ['a checkbox click', '- [ ] task\n', nothing, (page) => page.locator('#editor .mbe-checkbox').click()],
];

for (const [name, source, prepare, change] of CASES) {
  test(`undo and redo: ${name} is one step, and undo restores the selection`, async ({ page }) => {
    await open(page, source);
    await page.locator('#editor .mbe-block').last().click();
    await page.keyboard.press('End');
    await prepare(page);
    await frame(page);
    const before = { md: await md(page), selection: await selection(page) };
    await change(page);
    const after = await md(page);
    expect(after).not.toBe(before.md);
    await page.keyboard.press('Control+z');
    expect(await md(page)).toBe(before.md);
    expect(await selection(page)).toBe(before.selection);
    await page.keyboard.press('Control+Shift+z');
    expect(await md(page)).toBe(after);
    // Ctrl+Y redoes too, on Windows and Linux.
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+y');
    expect(await md(page)).toBe(after);
  });
}

test('undo: typing within a second is one step; a pause or a caret move starts a new one', async ({ page }) => {
  await open(page, '\n');
  await page.locator('#editor').click();
  await page.keyboard.type('one two');
  await page.waitForTimeout(1100);
  await page.keyboard.type(' three');
  await page.keyboard.press('ArrowLeft');
  await frame(page);
  await page.keyboard.press('ArrowRight');
  await frame(page);
  await page.keyboard.type(' four');
  await page.keyboard.press('Control+z');
  expect(await blocks(page)).toEqual(['p:one two three']);
  await page.keyboard.press('Control+z');
  expect(await blocks(page)).toEqual(['p:one two']);
  await page.keyboard.press('Control+z');
  expect(await blocks(page)).toEqual(['p:']);
});

test('undo: a new change after undo drops the redo steps', async ({ page }) => {
  await open(page, 'a\n');
  await page.locator('#editor p').click();
  await page.keyboard.press('End');
  await page.keyboard.type('b');
  await page.keyboard.press('Control+z');
  await page.keyboard.type('c');
  await page.keyboard.press('Control+Shift+z');
  expect(await md(page)).toBe('ac\n');
});
