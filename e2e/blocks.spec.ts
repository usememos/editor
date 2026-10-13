// Block selection: whole blocks selected with Escape, then deleted, copied,
// cut, duplicated, replaced by a paste, or changed by the block keys.

import { blocks, expect, md, type Page, test } from './helpers';

const DOC = '# Plan\n\nFirst paragraph.\n\n- one\n- two\n  - nested\n\nLast paragraph.\n';

async function load(page: Page, markdown = DOC) {
  await page.goto(`/?md=${encodeURIComponent(markdown)}`);
}

/** Puts the caret at the end of the text of the block element matching `selector`. */
async function caretIn(page: Page, selector: string) {
  await page.locator(`#editor ${selector}`).first().click();
  await page.keyboard.press('End');
}

const selected = (page: Page) =>
  page.evaluate(() => {
    const text = (c: any[]) => c.map((s) => s.text).join('');
    return (window as any).editor.selectedBlocks.map((b: any) => (b.content ? text(b.content) : b.type)) as string[];
  });

const copy = (page: Page, type: 'copy' | 'cut') =>
  page.evaluate((type) => {
    const data = new DataTransfer();
    document.activeElement!.dispatchEvent((window as any).clipboardEvent(type, data));
    return { text: data.getData('text/plain'), html: data.getData('text/html') };
  }, type);

const paste = (page: Page, text: string) =>
  page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.activeElement!.dispatchEvent((window as any).clipboardEvent('paste', data));
  }, text);

test('Escape selects the block with the caret and highlights it; Escape again leaves the editor', async ({ page }) => {
  await load(page);
  await caretIn(page, 'p');
  await page.keyboard.press('Escape');
  expect(await selected(page)).toEqual(['First paragraph.']);
  await expect(page.locator('#editor .mbe-block-selected')).toHaveCount(1);
  await expect(page.locator('#editor .mbe-block-selected')).toHaveText('First paragraph.');
  await expect(page.locator('#editor')).toHaveClass(/mbe-block-selecting/);
  // No text highlight and no toolbar: the blocks are selected, not their text.
  await expect(page.locator('.mbe-toolbar')).toBeHidden();
  expect(await page.evaluate(() => document.getSelection()!.isCollapsed)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).editor.hasFocus())).toBe(false);
  expect(await selected(page)).toEqual([]);
  await expect(page.locator('#editor .mbe-block-selected')).toHaveCount(0);
});

test('Escape over a text selection that crosses blocks selects all of them', async ({ page }) => {
  await load(page);
  await caretIn(page, 'p');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  // On a slow machine the selectionchange for the second Shift+ArrowDown can
  // arrive after the next key, and reopen the toolbar that Escape closed.
  await expect.poll(() => page.evaluate(() => (window as any).editor.state.selection.focus.blockId)).toBe(
    await page.evaluate(() => (window as any).editor.state.doc.blocks[3].id),
  );
  await expect(page.locator('.mbe-toolbar')).toBeVisible();
  await page.keyboard.press('Escape'); // closes the toolbar
  await page.keyboard.press('Escape');
  expect(await selected(page)).toEqual(['First paragraph.', 'one', 'two']);
});

test('arrows move the block selection; Shift extends it in either direction', async ({ page }) => {
  await load(page);
  await caretIn(page, 'p');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowDown');
  expect(await selected(page)).toEqual(['one']);
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await selected(page)).toEqual(['one', 'two', 'nested']);
  await page.keyboard.press('Shift+ArrowUp');
  expect(await selected(page)).toEqual(['one', 'two']);
  // Past the anchor, the selection grows upward.
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  expect(await selected(page)).toEqual(['First paragraph.', 'one']);
  await page.keyboard.press('ArrowUp');
  expect(await selected(page)).toEqual(['Plan']);
  // At the first block the selection stays.
  await page.keyboard.press('ArrowUp');
  expect(await selected(page)).toEqual(['Plan']);
  await page.keyboard.press('Control+a');
  expect(await selected(page)).toHaveLength(6);
});

test('Backspace deletes the selected blocks in one undo step; the rest saves byte for byte', async ({ page }) => {
  await load(page, '# Plan\n\n*First*   paragraph.\n\n* one\n* two\n\nLast paragraph.\n');
  await caretIn(page, '.mbe-list-item');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Backspace');
  expect(await blocks(page)).toEqual(['h1:Plan', 'p:First   paragraph.', 'p:Last paragraph.']);
  expect(await md(page)).toBe('# Plan\n\n*First*   paragraph.\n\nLast paragraph.\n');
  expect(await selected(page)).toEqual([]);
  // The caret is at the end of the block before, ready to type.
  await page.keyboard.type('!');
  expect(await blocks(page)).toEqual(['h1:Plan', 'p:First   paragraph.!', 'p:Last paragraph.']);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('# Plan\n\n*First*   paragraph.\n\n* one\n* two\n\nLast paragraph.\n');
});

test('Delete removes a parent item; its nested item moves under the item above', async ({ page }) => {
  await load(page);
  await page.locator('#editor .mbe-list-item', { hasText: 'two' }).click();
  await page.keyboard.press('Escape');
  expect(await selected(page)).toEqual(['two']);
  await page.keyboard.press('Delete');
  expect(await blocks(page)).toEqual(['h1:Plan', 'p:First paragraph.', 'ul0:one', 'ul1:nested', 'p:Last paragraph.']);
  expect(await md(page)).toBe('# Plan\n\nFirst paragraph.\n\n- one\n  - nested\n\nLast paragraph.\n');
});

test('copy writes the whole selected blocks as Markdown; cut also removes them', async ({ page }) => {
  await load(page);
  await page.locator('#editor .mbe-list-item', { hasText: 'two' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+ArrowDown');
  const copied = await copy(page, 'copy');
  expect(copied.text).toBe('- two\n  - nested');
  expect(copied.html).toContain('data-mbe-markdown');
  expect(await blocks(page)).toHaveLength(6);
  const cut = await copy(page, 'cut');
  expect(cut.text).toBe('- two\n  - nested');
  expect(await blocks(page)).toEqual(['h1:Plan', 'p:First paragraph.', 'ul0:one', 'p:Last paragraph.']);
});

test('copy of a selected empty paragraph gives an empty line, not nothing', async ({ page }) => {
  await load(page, 'a\n\n&nbsp;\n\nb\n');
  await page.locator('#editor p').nth(1).click();
  await page.keyboard.press('Escape');
  expect(await selected(page)).toEqual(['']);
  expect((await copy(page, 'copy')).text).toBe('&nbsp;');
});

test('paste over selected blocks replaces them', async ({ page }) => {
  await load(page);
  await caretIn(page, 'p');
  await page.keyboard.press('Escape');
  await paste(page, '## New section\n\nWith text.');
  expect(await blocks(page)).toEqual(['h1:Plan', 'h2:New section', 'p:With text.', 'ul0:one', 'ul0:two', 'ul1:nested', 'p:Last paragraph.']);
  expect(await selected(page)).toEqual([]);
  await page.keyboard.type('!');
  expect((await blocks(page))[2]).toBe('p:With text.!');
});

test('Mod+D duplicates the selected blocks and selects the copies', async ({ page }) => {
  await load(page);
  await page.locator('#editor h1').click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Control+d');
  expect(await blocks(page)).toEqual([
    'h1:Plan',
    'p:First paragraph.',
    'h1:Plan',
    'p:First paragraph.',
    'ul0:one',
    'ul0:two',
    'ul1:nested',
    'p:Last paragraph.',
  ]);
  const ids = await page.evaluate(() => (window as any).editor.state.doc.blocks.map((b: any) => b.id));
  const sel = await page.evaluate(() => (window as any).editor.selectedBlocks.map((b: any) => b.id));
  expect(sel).toEqual([ids[2], ids[3]]);
});

test('block type keys, Tab and marks apply to every selected block, which stay selected', async ({ page }) => {
  await load(page, 'alpha\n\nbeta\n\ngamma\n');
  await page.locator('#editor p').first().click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Control+Shift+8');
  expect(await blocks(page)).toEqual(['ul0:alpha', 'ul0:beta', 'p:gamma']);
  expect(await selected(page)).toEqual(['alpha', 'beta']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Control+Alt+2');
  expect(await blocks(page)).toEqual(['ul0:alpha', 'ul0:beta', 'h2:gamma']);
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Control+b');
  expect(await md(page)).toBe('- alpha\n- **beta**\n\n## **gamma**\n');
  // ArrowUp selects the block above the selection, ArrowDown the one below it.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  expect(await blocks(page)).toEqual(['ul0:alpha', 'ul1:beta', 'h2:gamma']);
  expect(await selected(page)).toEqual(['beta']);
});

test('typing does nothing while blocks are selected; Enter and arrows go back to editing', async ({ page }) => {
  await load(page, 'alpha\n\nbeta\n');
  await page.locator('#editor p').first().click();
  await page.keyboard.press('Escape');
  await page.keyboard.type('xyz');
  expect(await blocks(page)).toEqual(['p:alpha', 'p:beta']);
  await page.keyboard.press('Enter');
  expect(await selected(page)).toEqual([]);
  await page.keyboard.type('!');
  expect(await blocks(page)).toEqual(['p:alpha!', 'p:beta']);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('<');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('>');
  expect(await blocks(page)).toEqual(['p:<alpha!>', 'p:beta']);
});

test('a click in the text leaves block selection and puts the caret there', async ({ page }) => {
  await load(page, 'alpha\n\nbeta\n');
  await page.locator('#editor p').first().click();
  await page.keyboard.press('Escape');
  await page.locator('#editor p').nth(1).click();
  expect(await selected(page)).toEqual([]);
  await expect(page.locator('#editor .mbe-block-selected')).toHaveCount(0);
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  expect(await blocks(page)).toEqual(['p:alpha', 'p:beta!']);
});

test('tables, code blocks and dividers are selected and deleted as whole blocks', async ({ page }) => {
  await load(page, 'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\n```js\nlet a = 1;\n```\n\nend\n');
  await page.locator('#editor td').first().click();
  await page.keyboard.press('Escape');
  expect(await selected(page)).toEqual(['table']);
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await selected(page)).toEqual(['table', 'divider', 'let a = 1;']);
  await page.keyboard.press('Backspace');
  expect(await blocks(page)).toEqual(['p:intro', 'p:end']);
  expect(await md(page)).toBe('intro\n\nend\n');
});

test('selection events and the public API', async ({ page }) => {
  await load(page, 'alpha\n\nbeta\n');
  await page.locator('#editor p').first().click();
  const events = await page.evaluate(() => {
    const editor = (window as any).editor;
    let count = 0;
    editor.on('selectionChange', () => count++);
    const ok = editor.commands.selectBlocks();
    const during = editor.selectedBlocks.length;
    editor.setSelection({ anchor: { block: 1, offset: 0 }, focus: { block: 1, offset: 0 } });
    return { ok, during, after: editor.selectedBlocks.length, count };
  });
  expect(events).toEqual({ ok: true, during: 1, after: 0, count: 2 });
});

test('read-only: Escape leaves the editor without selecting blocks', async ({ page }) => {
  await load(page, 'alpha\n');
  await page.locator('#editor p').click();
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  expect(await page.evaluate(() => (window as any).editor.commands.selectBlocks())).toBe(false);
  await expect(page.locator('#editor .mbe-block-selected')).toHaveCount(0);
});
