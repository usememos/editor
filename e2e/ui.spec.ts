import { blocks, expect, md, test } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/?empty');
  await page.locator('#editor').click();
});

const slashMenu = (page: import('@playwright/test').Page) => page.locator('.mbe-slash-menu');

test('slash menu: opens, filters, picks with the keyboard', async ({ page }) => {
  await page.keyboard.type('/');
  await expect(slashMenu(page)).toBeVisible();
  await expect(slashMenu(page).locator('.mbe-menu-item')).toHaveCount(14);
  await page.keyboard.type('head');
  await expect(slashMenu(page).locator('.mbe-menu-item')).toHaveText([/Heading 1/, /Heading 2/, /Heading 3/, /Heading 4/]);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(slashMenu(page)).toBeHidden();
  await page.keyboard.type('Title');
  expect(await blocks(page)).toEqual(['h2:Title']);
});

test('slash menu: converts a block that has text, like Linear', async ({ page }) => {
  await page.keyboard.type('Release notes /h2');
  await page.keyboard.press('Enter');
  expect(await blocks(page)).toEqual(['h2:Release notes']);
  expect(await md(page)).toBe('## Release notes\n');
  await page.keyboard.type(' /quo');
  await page.keyboard.press('Enter');
  expect(await blocks(page)).toEqual(['quote:Release notes']);
});

test('slash menu: a late selectionchange keeps the highlighted item', async ({ page }) => {
  await page.keyboard.type('/head');
  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')));
  await page.keyboard.press('Enter');
  await page.keyboard.type('Title');
  expect(await blocks(page)).toEqual(['h2:Title']);
});

test('slash menu: aria wiring for screen readers', async ({ page }) => {
  await page.keyboard.type('/');
  const active = await page.locator('#editor').getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  await expect(page.locator(`#${active}`)).toHaveAttribute('aria-selected', 'true');
  await expect(slashMenu(page)).toHaveAttribute('role', 'listbox');
});

test('slash menu: Escape closes and keeps the text', async ({ page }) => {
  await page.keyboard.type('/quo');
  await page.keyboard.press('Escape');
  await expect(slashMenu(page)).toBeHidden();
  expect(await blocks(page)).toEqual(['p:/quo']);
});

test('slash menu: no results, and does not open inside a word', async ({ page }) => {
  await page.keyboard.type('/zz');
  await expect(slashMenu(page)).toContainText('No results');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('a/b');
  await expect(slashMenu(page)).toBeHidden();
});

test('slash menu: inserting a table below text, then typing in cells with Tab', async ({ page }) => {
  await page.keyboard.type('intro');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  expect(await blocks(page)).toEqual(['p:intro', 'table:||/||/||']);
  await page.keyboard.type('A');
  await page.keyboard.press('Tab');
  await page.keyboard.type('B');
  expect(await blocks(page)).toEqual(['p:intro', 'table:A|B|/||/||']);
  expect(await md(page)).toContain('| A | B |');
});

test('formatting toolbar: appears on selection and applies marks', async ({ page }) => {
  await page.keyboard.type('make this bold');
  const toolbar = page.locator('.mbe-toolbar');
  await expect(toolbar).toBeHidden();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
  await expect(toolbar).toBeVisible();
  await toolbar.locator('.mbe-tool-bold').click();
  expect(await md(page)).toBe('make this **bold**\n');
  await expect(toolbar.locator('.mbe-tool-bold')).toHaveAttribute('aria-pressed', 'true');
  // The selection survives the click.
  await page.keyboard.press('Control+i');
  expect(await md(page)).toBe('make this ***bold***\n');
  await page.keyboard.press('ArrowRight');
  await expect(toolbar).toBeHidden();
});

test('formatting toolbar: Escape keeps it closed until the selection changes', async ({ page }) => {
  const toolbar = page.locator('.mbe-toolbar');
  await page.keyboard.type('format me');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Control+b');
  await expect(toolbar).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toolbar).toBeHidden();
  // A late selection event for the same selection, as after a change, does not bring it back.
  await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await expect(toolbar).toBeHidden();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(toolbar).toBeVisible();
});

test('formatting toolbar: nine controls in three groups, named without shortcuts', async ({ page }) => {
  await page.keyboard.type('format me');
  await page.keyboard.press('Shift+Home');
  // The toolbar follows the selection, which the browser reports after the key press.
  const toolbar = page.locator('.mbe-toolbar');
  await expect(toolbar).toBeVisible();
  const controls = await toolbar
    .locator('button, .mbe-tool-sep')
    .evaluateAll((els) => els.map((el) => (el.tagName === 'BUTTON' ? [el.getAttribute('aria-label'), el.querySelectorAll('svg.mbe-icon').length] : '|')));
  expect(controls).toEqual([
    ['Text style', 2],
    '|',
    ['Bold', 1],
    ['Italic', 1],
    ['Strikethrough', 1],
    ['Code', 1],
    ['Link', 1],
    '|',
    ['Quote', 1],
    ['Code block', 1],
    ['List', 2],
  ]);
  // No shortcut is shown anywhere; assistive technology gets it from aria-keyshortcuts.
  await toolbar.locator('.mbe-tool-text-style').click();
  const text = await page.evaluate(() =>
    [...document.querySelectorAll('.mbe-toolbar, .mbe-toolbar *, .mbe-text-style-menu, .mbe-text-style-menu *')]
      .flatMap((el) => [el.textContent, el.getAttribute('title'), el.getAttribute('aria-label')])
      .join(' '),
  );
  expect(text).not.toMatch(/⌘|Ctrl|Alt|Shift|⇧|⌥/);
  await expect(toolbar.locator('.mbe-tool-bold')).toHaveAttribute('aria-keyshortcuts', /^(Meta|Control)\+B$/);
  await expect(page.locator('.mbe-text-style-menu [role=menuitemradio]').nth(2)).toHaveAttribute('aria-keyshortcuts', /^(Meta|Control)\+Alt\+2$/);
});

test('formatting toolbar: the text style menu sets a style on every selected block', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setMarkdown('one\n\ntwo\n\nthree\n'));
  await page.locator('#editor p').first().click();
  await page.keyboard.press('Control+a');
  const toolbar = page.locator('.mbe-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.locator('.mbe-tool-text-style').click();
  const menu = page.locator('.mbe-text-style-menu');
  await expect(menu.locator('.mbe-menu-item')).toHaveText(['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4']);
  await expect(menu.locator('[aria-checked=true]')).toHaveText('Text');
  await menu.locator('.mbe-menu-item', { hasText: 'Heading 2' }).click();
  await expect(menu).toBeHidden();
  expect(await md(page)).toBe('## one\n\n## two\n\n## three\n');
  // The selection and the toolbar stay, and show the new style.
  await expect(toolbar).toBeVisible();
  await expect(toolbar.locator('.mbe-tool-text-style')).toHaveClass(/mbe-active/);
  await toolbar.locator('.mbe-tool-text-style').click();
  await expect(menu.locator('[aria-checked=true]')).toHaveText('Heading 2');
  // Picking the current style changes nothing.
  await menu.locator('.mbe-menu-item', { hasText: 'Heading 2' }).click();
  expect(await md(page)).toBe('## one\n\n## two\n\n## three\n');
  await page.keyboard.press('Control+z');
  expect(await blocks(page)).toEqual(['p:one', 'p:two', 'p:three']);
});

test('formatting toolbar: the list menu and quote toggle, code block merges', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setMarkdown('one\n\n**two**\n'));
  await page.locator('#editor p').first().click();
  await page.keyboard.press('Control+a');
  const toolbar = page.locator('.mbe-toolbar');
  const list = page.locator('.mbe-list-menu');
  await toolbar.locator('.mbe-tool-list').click();
  await expect(list.locator('.mbe-menu-item')).toHaveText(['Bulleted list', 'Numbered list', 'To-do list']);
  await list.locator('.mbe-menu-item', { hasText: 'To-do list' }).click();
  expect(await md(page)).toBe('- [ ] one\n- [ ] **two**\n');
  await expect(toolbar.locator('.mbe-tool-list')).toHaveClass(/mbe-active/);
  await toolbar.locator('.mbe-tool-list').click();
  await list.locator('.mbe-menu-item', { hasText: 'To-do list' }).click();
  expect(await md(page)).toBe('one\n\n**two**\n');
  await toolbar.locator('.mbe-tool-quote').click();
  await expect(toolbar.locator('.mbe-tool-quote')).toHaveAttribute('aria-pressed', 'true');
  await toolbar.locator('.mbe-tool-quote').click();
  expect(await md(page)).toBe('one\n\n**two**\n');
  await toolbar.locator('.mbe-tool-code-block').click();
  expect(await md(page)).toBe('```\none\ntwo\n```\n');
  // The selection is now code, where the toolbar does not show.
  await expect(toolbar).toBeHidden();
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('one\n\n**two**\n');
});

test('formatting toolbar: menus work from the keyboard, and Escape closes the menu first', async ({ page }) => {
  await page.keyboard.type('title');
  await page.keyboard.press('Shift+Home');
  const toolbar = page.locator('.mbe-toolbar');
  await toolbar.locator('.mbe-tool-text-style').click();
  const menu = page.locator('.mbe-text-style-menu');
  await expect(menu).toBeVisible();
  await expect(toolbar.locator('.mbe-tool-text-style')).toHaveAttribute('aria-expanded', 'true');
  // The highlight starts on the current style.
  await expect(menu.locator('.mbe-highlighted')).toHaveText('Text');
  await expect(page.locator('#editor')).toHaveAttribute('aria-activedescendant', /mbe-menu-/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  expect(await md(page)).toBe('# title\n');
  await toolbar.locator('.mbe-tool-list').click();
  await expect(page.locator('.mbe-list-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.mbe-list-menu')).toBeHidden();
  await expect(page.locator('#editor')).not.toHaveAttribute('aria-activedescendant', /./);
  await expect(toolbar).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toolbar).toBeHidden();
});

test('formatting toolbar: a press outside a menu closes it', async ({ page }) => {
  await page.keyboard.type('title');
  await page.keyboard.press('Shift+Home');
  await page.locator('.mbe-tool-list').click();
  await expect(page.locator('.mbe-list-menu')).toBeVisible();
  // Opening the other menu closes this one.
  await page.locator('.mbe-tool-text-style').click();
  await expect(page.locator('.mbe-list-menu')).toBeHidden();
  await expect(page.locator('.mbe-text-style-menu')).toBeVisible();
  await page.locator('h2.label').first().click();
  await expect(page.locator('.mbe-text-style-menu')).toBeHidden();
});

test('formatting toolbar: in a table cell, only inline controls', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setMarkdown('| cell text |\n| - |\n| b |\n'));
  await page.locator('#editor th').click();
  await page.keyboard.press('Shift+Home');
  const toolbar = page.locator('.mbe-toolbar');
  await expect(toolbar).toBeVisible();
  await expect(toolbar.locator('button:visible')).toHaveCount(5);
  await expect(toolbar.locator('.mbe-tool-sep:visible')).toHaveCount(0);
  await expect(toolbar.locator('button:visible').first()).toHaveAttribute('aria-label', 'Bold');
});

test('formatting toolbar: the items option picks controls, in the built-in order', async ({ page }) => {
  await page.evaluate(() => {
    const { Editor } = (window as any).core;
    (window as any).editor.destroy();
    (window as any).editor = new Editor({ element: document.getElementById('editor'), content: 'word', toolbar: { items: ['link', 'list', 'bold'] } });
  });
  await page.locator('#editor p').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await expect(page.locator('.mbe-toolbar')).toBeVisible();
  const controls = await page
    .locator('.mbe-toolbar')
    .locator('button, .mbe-tool-sep')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? '|'));
  expect(controls).toEqual(['Bold', 'Link', '|', 'List']);
});

test('formatting toolbar: a tooltip names the button after a pause, and hides while a menu is open', async ({ page }) => {
  await page.keyboard.type('format me');
  await page.keyboard.press('Shift+Home');
  const tooltip = page.locator('.mbe-tooltip');
  await page.locator('.mbe-tool-italic').hover();
  await page.waitForTimeout(200);
  await expect(tooltip).toBeHidden();
  await expect(tooltip).toHaveText('Italic');
  await expect(tooltip).toBeVisible();
  // Moving along the buttons shows the next one at once.
  await page.locator('.mbe-tool-strike').hover();
  await expect(tooltip).toHaveText('Strikethrough', { timeout: 200 });
  await page.locator('.mbe-tool-list').click();
  await expect(tooltip).toBeHidden();
});

test('icons: every menu row, toolbar button and the block handle shows a Lucide icon', async ({ page }) => {
  await page.keyboard.type('/');
  const rows = slashMenu(page).locator('.mbe-menu-item');
  await expect(rows).toHaveCount(14);
  await expect(slashMenu(page).locator('.mbe-menu-icon > svg.mbe-icon')).toHaveCount(14);
  await page.keyboard.type('table');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+/');
  const menu = page.locator('.mbe-block-menu');
  await expect(menu.locator('.mbe-menu-item')).toHaveCount(9);
  await expect(menu.locator('.mbe-menu-icon > svg.mbe-icon')).toHaveCount(9);
  // The Align row ends in a chevron, and its submenu rows have icons too.
  await expect(menu.locator('.mbe-menu-submenu > svg.mbe-icon')).toHaveCount(1);
  await menu.locator('.mbe-menu-item', { hasText: 'Align' }).hover();
  await expect(page.locator('.mbe-submenu .mbe-menu-icon > svg.mbe-icon')).toHaveCount(3);
  // The icon takes the row's color, so Delete's icon is the danger color.
  const colors = await menu.locator('.mbe-danger').first().evaluate((row) => [getComputedStyle(row).color, getComputedStyle(row.querySelector('svg')!).color]);
  expect(colors[1]).toBe(colors[0]);
  await page.keyboard.press('Escape');
  await page.locator('#editor table').hover();
  await expect(page.locator('.mbe-block-handle svg.mbe-icon')).toHaveCount(1);
  const size = await page.locator('.mbe-block-handle svg').evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height]);
  expect(size).toEqual([16, 16]);
});

test('icons: the icons option replaces one icon everywhere it appears', async ({ page }) => {
  await page.evaluate(() => {
    const { Editor } = (window as any).core;
    (window as any).editor.destroy();
    const star = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    star.setAttribute('class', 'host-icon');
    (window as any).editor = new Editor({
      element: document.getElementById('editor'),
      content: 'word\n\n| a |\n| - |\n| b |',
      icons: { delete: star, deleteRow: '×', bold: 'B' },
    });
  });
  await page.locator('#editor td').first().click();
  // The editor reads the caret from the selectionchange that follows the click.
  await expect.poll(() => page.evaluate(() => (window as any).editor.isActive('table'))).toBe(true);
  await page.keyboard.press('Control+/');
  const menu = page.locator('.mbe-block-menu');
  const icon = (label: string) =>
    menu
      .locator('.mbe-menu-item')
      .filter({ has: page.locator('.mbe-menu-label', { hasText: new RegExp(`^${label}$`) }) })
      .locator('.mbe-menu-icon');
  await expect(icon('Delete').locator('svg.host-icon')).toHaveCount(1);
  await expect(icon('Delete row')).toHaveText('×');
  await expect(icon('Delete column').locator('svg.mbe-icon')).toHaveCount(1);
  await expect(icon('Duplicate').locator('svg.mbe-icon')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.locator('#editor p').dblclick();
  await expect(page.locator('.mbe-tool-bold')).toHaveText('B');
  await expect(page.locator('.mbe-tool-italic svg.mbe-icon')).toHaveCount(1);
});

test('link: Ctrl+K on a selection, then edit and remove', async ({ page }) => {
  await page.keyboard.type('see docs');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Control+k');
  const input = page.locator('.mbe-popover-input');
  await expect(input).toBeFocused();
  await input.fill('https://example.com');
  await input.press('Enter');
  expect(await md(page)).toBe('see [docs](https://example.com)\n');
  await expect(page.locator('#editor a.mbe-link')).toHaveAttribute('href', 'https://example.com');
  // Focus is back in the editor.
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  expect(await md(page)).toBe('see [docs](https://example.com)!\n');
});

test('link: Ctrl+K with nothing to link is left to the app', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).modK = [];
    window.addEventListener('keydown', (e) => e.key === 'k' && (window as any).modK.push(e.defaultPrevented));
  });
  await page.keyboard.type('see docs');
  await page.keyboard.press('Control+k');
  await expect(page.locator('.mbe-popover-input')).toBeHidden();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Control+k');
  await expect(page.locator('.mbe-popover-input')).toBeFocused();
  expect(await page.evaluate(() => (window as any).modK)).toEqual([false, true]);
});

test('link: pasting a URL over selected text', async ({ page }) => {
  await page.keyboard.type('click here');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'https://x.dev');
    document.getElementById('editor')!.dispatchEvent((window as any).clipboardEvent('paste', data));
  });
  expect(await md(page)).toBe('click [here](https://x.dev)\n');
});

test('block handle: paragraphs do not have it, code blocks do; the block menu duplicates and deletes', async ({ page }) => {
  await page.keyboard.type('intro');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```js ');
  await page.keyboard.type('let a = 1;');
  const blockHandle = page.locator('.mbe-block-handle');
  await page.locator('#editor p').first().hover();
  await page.waitForTimeout(400); // past the block handle's hide delay
  await expect(blockHandle).toBeHidden();
  await page.locator('#editor .mbe-code pre').hover();
  await expect(blockHandle).toBeVisible();
  await blockHandle.click();
  const menu = page.locator('.mbe-block-menu');
  await expect(menu.locator('.mbe-menu-item')).toHaveText([/Duplicate/, /Delete/]);
  await menu.locator('.mbe-menu-item', { hasText: 'Duplicate' }).click();
  expect(await blocks(page)).toEqual(['p:intro', 'code(js):let a = 1;', 'code(js):let a = 1;']);
  await page.locator('#editor .mbe-code pre').last().hover();
  await blockHandle.click();
  await menu.locator('.mbe-menu-item', { hasText: 'Delete' }).click();
  expect(await blocks(page)).toEqual(['p:intro', 'code(js):let a = 1;']);
});

test('block menu: a press outside closes it, in the editor text or with the editor unfocused', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent('intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nafter')}`);
  const blockHandle = page.locator('.mbe-block-handle');
  const menu = page.locator('.mbe-block-menu');
  const open = async () => {
    await page.locator('#editor table').hover();
    await blockHandle.click();
    await expect(menu).toBeVisible();
  };
  // A press in another paragraph keeps focus in the editor, and still closes the menu.
  await page.locator('#editor td').first().click();
  await open();
  await page.locator('#editor p').last().click();
  await expect(menu).toBeHidden();
  // Opened while the editor is not focused, with the caret already in the table: the
  // editor takes focus, so the menu's keys work and a press outside closes it.
  await page.locator('#editor td').first().click();
  await page.mouse.click(2, 2);
  await open();
  expect(await page.evaluate(() => document.activeElement?.closest('#editor') !== null)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.mouse.click(2, 2);
  await open();
  await page.mouse.click(2, 2);
  await expect(menu).toBeHidden();
});

test('block menu with Ctrl+/: opens in a table cell, not in a paragraph', async ({ page }) => {
  await page.keyboard.type('item');
  await page.keyboard.press('Control+/');
  const menu = page.locator('.mbe-block-menu');
  await expect(menu).toBeHidden();
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A');
  await page.keyboard.press('Control+/');
  await expect(menu).toBeVisible();
  await menu.locator('.mbe-menu-item', { hasText: 'Add column right' }).click();
  expect(await blocks(page)).toEqual(['p:item', 'table:A|||/|||/|||']);
  await expect(menu).toBeHidden();
});

test('block handle and toolbar never reach the saved Markdown or the clipboard', async ({ page }) => {
  await page.keyboard.type('plain');
  await page.locator('#editor p').hover();
  await page.keyboard.press('Control+a');
  const copied = await page.evaluate(() => {
    const data = new DataTransfer();
    document.getElementById('editor')!.dispatchEvent((window as any).clipboardEvent('copy', data));
    return { text: data.getData('text/plain'), html: data.getData('text/html') };
  });
  expect(copied.text).toBe('plain');
  expect(copied.html).not.toContain('mbe-block-handle');
  expect(copied.html).not.toContain('mbe-toolbar');
});

test('placeholder shows only in an empty document', async ({ page }) => {
  const first = page.locator('#editor > p').first();
  const content = await first.evaluate((el) => getComputedStyle(el, '::before').content);
  expect(content).toContain('Write something');
  await page.keyboard.type('x');
  const after = await first.evaluate((el) => getComputedStyle(el, '::before').content);
  expect(after === 'none' || after === 'normal' || after === '""').toBe(true);
});

for (const [item, expected] of [
  ['Text', ['p:word']],
  ['Heading 1', ['h1:word']],
  ['Heading 2', ['h2:word']],
  ['Heading 3', ['h3:word']],
  ['Heading 4', ['h4:word']],
  ['Bulleted list', ['ul0:word']],
  ['Numbered list', ['ol0:word']],
  ['To-do list', ['task0[ ]:word']],
  ['Quote', ['quote:word']],
  ['Callout', ['note:word']],
  ['Collapsible section', ['details:word', 'p:', '/details']],
  ['Code block', ['code():word']],
  ['Table', ['p:word', 'table:||/||/||']],
  ['Divider', ['p:word', 'hr', 'p:']],
] as const) {
  test(`slash menu: clicking "${item}" makes that block`, async ({ page }) => {
    await page.keyboard.type('word /');
    await slashMenu(page).locator('.mbe-menu-item', { hasText: item }).click();
    await expect(slashMenu(page)).toBeHidden();
    expect(await blocks(page)).toEqual(expected);
    // Focus is still in the editor, ready to type.
    expect(await page.evaluate(() => (window as any).editor.hasFocus())).toBe(true);
    // One undo step takes it back to the text before the "/".
    await page.keyboard.press('Control+z');
    expect(await blocks(page)).toEqual(['p:word /']);
  });
}

test('slash menu: closes when the editor loses focus', async ({ page }) => {
  await page.keyboard.type('/');
  await expect(slashMenu(page)).toBeVisible();
  await page.locator('h2.label').first().click();
  await expect(slashMenu(page)).toBeHidden();
});

test('menus and the toolbar stay on screen on a short, narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 420 });
  await page.evaluate(() => (window as any).editor.setMarkdown(Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n\n')));
  const onScreen = (selector: string) =>
    page.locator(selector).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    });
  // Near the bottom of the screen, near the top, and in the middle.
  for (const n of [5, 0, 2]) {
    await page.locator('#editor p').nth(n).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' /');
    await expect(slashMenu(page)).toBeVisible();
    expect(await onScreen('.mbe-slash-menu'), `slash menu after line ${n}`).toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Home');
    await expect(page.locator('.mbe-toolbar')).toBeVisible();
    expect(await onScreen('.mbe-toolbar'), `toolbar on line ${n}`).toBe(true);
  }
  // A toolbar wider than the screen scrolls sideways, so its last control can be reached.
  await page.locator('.mbe-tool-list').click();
  await expect(page.locator('.mbe-list-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  // The highlighted item scrolls into view in a menu that had to shrink.
  await page.keyboard.press('End');
  await page.keyboard.type(' /');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
  const visible = await page.evaluate(() => {
    const item = document.querySelector('.mbe-slash-menu .mbe-highlighted')!.getBoundingClientRect();
    const menu = document.querySelector('.mbe-slash-menu')!.getBoundingClientRect();
    return item.top >= menu.top - 1 && item.bottom <= menu.bottom + 1;
  });
  expect(visible).toBe(true);
});

for (const [action, expected] of [
  ['Add row above', 'table:a|b/|/c|d'],
  ['Add row below', 'table:a|b/c|d/|'],
  ['Add column left', 'table:a||b/c||d'],
  ['Add column right', 'table:a|b|/c|d|'],
  ['Delete row', 'table:a|b'],
  ['Delete column', 'table:a/c'],
] as const) {
  test(`block menu in a table: ${action}, undone in one step`, async ({ page }) => {
    await page.evaluate(() => (window as any).editor.setMarkdown('| a | b |\n| - | - |\n| c | d |\n'));
    await page.locator('#editor td', { hasText: 'd' }).click();
    await page.keyboard.press('Control+/');
    await page.locator('.mbe-block-menu .mbe-menu-item', { hasText: action }).click();
    expect(await blocks(page)).toEqual([expected]);
    await page.keyboard.press('Control+z');
    expect(await blocks(page)).toEqual(['table:a|b/c|d']);
  });
}

test('block menu in a table: alignment is saved in the delimiter row', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setMarkdown('| a | b |\n| - | - |\n| c | d |\n'));
  for (const [align, row] of [['Center', '| --- | :-: |'], ['Right', '| --- | --: |'], ['Left', '| --- | :-- |']]) {
    await page.locator('#editor td', { hasText: 'd' }).click();
    await page.keyboard.press('Control+/');
    // The choices are in an Align submenu, which opens on hover.
    await page.locator('.mbe-block-menu .mbe-menu-item', { hasText: 'Align' }).hover();
    await page.locator('.mbe-submenu .mbe-menu-item', { hasText: align }).click();
    expect((await md(page)).split('\n')[1]).toBe(row);
  }
});

test('links: Ctrl+click opens a link while editing, a plain click places the caret, and read-only opens on click', async ({ page, context }) => {
  await page.evaluate(() => (window as any).editor.setMarkdown('see [docs](https://example.com/docs) here\n'));
  // Do not leave the test sandbox: answer every request for the link page here.
  await context.route('https://example.com/**', (route) => route.fulfill({ body: 'docs' }));
  const link = page.locator('#editor a.mbe-link');
  await link.click();
  expect(context.pages()).toHaveLength(1);
  await page.keyboard.type('!');
  expect(await md(page)).toMatch(/^see \[d.*\]\(https:\/\/example\.com\/docs\) here\n$/);
  const [opened] = await Promise.all([context.waitForEvent('page'), link.click({ modifiers: ['Control'] })]);
  await opened.waitForLoadState();
  expect(opened.url()).toBe('https://example.com/docs');
  await opened.close();
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  const [again] = await Promise.all([context.waitForEvent('page'), link.click()]);
  expect(again.url()).toBe('https://example.com/docs');
});

test('code blocks have a copy button that copies the code, editing and read-only', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Reading the clipboard needs Chromium permissions');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/?md=${encodeURIComponent('before\n\n```js\nconst a = 1;\nconst b = 2;\n```')}`);
  const editor = page.locator('#editor');
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await expect.poll(() => page.evaluate(() => (window as any).editor.selectionToJSON().focus.offset)).toBe(6);
  const caret = await page.evaluate(() => (window as any).editor.selectionToJSON());
  const button = editor.locator('.mbe-code-copy');
  await expect(button).toHaveAttribute('aria-label', 'Copy code');
  await editor.locator('.mbe-code').hover();
  await button.click();
  await expect(button).toHaveAttribute('aria-label', 'Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const a = 1;\nconst b = 2;');
  // The click kept the caret where it was, and the button never reaches the Markdown.
  expect(await page.evaluate(() => (window as any).editor.selectionToJSON())).toEqual(caret);
  expect(await md(page)).toBe('before\n\n```js\nconst a = 1;\nconst b = 2;\n```');
  await expect(button).toHaveAttribute('aria-label', 'Copy code', { timeout: 3000 });

  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  await editor.locator('.mbe-code').hover();
  await button.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const a = 1;\nconst b = 2;');
});

test('codeCopy: false leaves code blocks without a copy button', async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(() => {
    const { Editor } = (window as any).core;
    const w = window as any;
    w.editor.destroy();
    w.editor = new Editor({ element: document.getElementById('editor'), content: '```\nx\n```', codeCopy: false });
  });
  await expect(page.locator('#editor .mbe-code')).toHaveCount(1);
  await expect(page.locator('#editor .mbe-code-copy')).toHaveCount(0);
});

/** Replaces the playground editor with one made from `options`, then focuses it. */
const remount = async (page: import('@playwright/test').Page, options: Record<string, unknown>) => {
  await page.evaluate((options) => {
    const { Editor } = (window as any).core;
    (window as any).editor.destroy();
    (window as any).editor = new Editor({ element: document.getElementById('editor'), ...options });
  }, options);
  await page.locator('#editor').click();
};

const hintedBlocks = (page: import('@playwright/test').Page) => page.locator('#editor .mbe-show-hint');
const beforeContent = (page: import('@playwright/test').Page, selector: string) =>
  page.locator(selector).evaluate((el) => getComputedStyle(el, '::before').content);

test('slash hint: off by default, so a new empty line shows nothing', async ({ page }) => {
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await expect(hintedBlocks(page)).toHaveCount(0);
});

test('slash hint: with slashHint, only the empty paragraph that has the caret shows it', async ({ page }) => {
  await remount(page, { placeholder: 'Write…', slashHint: true });
  // A single empty paragraph shows the placeholder, not the hint.
  await expect(hintedBlocks(page)).toHaveCount(0);
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(hintedBlocks(page)).toHaveCount(1);
  expect(await beforeContent(page, '#editor .mbe-show-hint')).toBe(`"Type '/' for commands"`);
  await page.keyboard.type('x');
  await expect(hintedBlocks(page)).toHaveCount(0);
});

test('slash hint: no hint without a slash menu', async ({ page }) => {
  await remount(page, { slashHint: true, slashMenu: false });
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await expect(hintedBlocks(page)).toHaveCount(0);
});

test('block hints: empty headings and quotes show their type only while editable', async ({ page }) => {
  await remount(page, { content: '# \n\n> &nbsp;\n\ntext' });
  // Firefox reports the computed content as `attr(data-hint)`, not the text, so
  // the text is read from the attribute and the pseudo-element only for 'none'.
  const hints = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#editor [data-hint]')].map((el) =>
        getComputedStyle(el, '::before').content === 'none' ? null : el.dataset.hint,
      ),
    );
  expect(await hints()).toEqual(['Heading 1', 'Quote']);
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  expect(await hints()).toEqual([null, null]);
});
