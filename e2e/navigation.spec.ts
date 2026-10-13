// Moving around: arrow keys through every kind of block, tables, keeping the
// caret in view in a scrolled editor, and selecting with the mouse.

import { SAMPLE } from '../playground/sample';
import { blocks, expect, md, type Page, test } from './helpers';

const open = (page: Page, markdown: string) => page.goto(`/?md=${encodeURIComponent(markdown)}`);
const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

/** Where the caret is, as "block:offset" or "block:offset@row,col". */
const caret = (page: Page) =>
  page.evaluate(() => {
    const editor = (window as any).editor;
    const { blockId, offset, cell } = editor.state.selection.focus;
    const index = editor.state.doc.blocks.findIndex((b: any) => b.id === blockId);
    return `${index}:${offset}${cell ? `@${cell.row},${cell.col}` : ''}`;
  });

/** Presses a key until the caret stops moving; returns the blocks it passed through, in order. */
async function walk(page: Page, key: 'ArrowDown' | 'ArrowUp') {
  const visited: number[] = [];
  let last = '';
  for (let i = 0; i < 80; i++) {
    await frame(page);
    const at = await caret(page);
    if (at === last) break;
    last = at;
    const index = Number(at.split(':')[0]);
    if (visited[visited.length - 1] !== index) visited.push(index);
    await page.keyboard.press(key);
  }
  return { visited, last };
}

test('ArrowDown visits every block of the sample in order, and ArrowUp comes back, changing nothing', async ({ page }) => {
  await open(page, SAMPLE);
  await page.locator('#editor h2').click();
  await page.keyboard.press('Home');
  // 14 is the divider, which holds no caret.
  const all = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15];
  const down = await walk(page, 'ArrowDown');
  expect(down.visited).toEqual(all);
  expect(down.last).toBe('15:36');
  const up = await walk(page, 'ArrowUp');
  expect(up.visited).toEqual([...all].reverse());
  expect(up.last).toBe('0:0');
  expect(await md(page)).toBe(SAMPLE);
});

// Line positions depend on the font, so this also runs with fonts other than the default.
for (const font of ['', 'DejaVu Sans', 'FreeSans']) {
  test(`table: ArrowDown and ArrowUp move within a column, and leave the table at its edges${font ? ` (${font})` : ''}`, async ({ page }) => {
    await open(page, 'above\n\n| a | b |\n| - | - |\n| c | d |\n| e | f |\n\nbelow\n');
    if (font) await page.addStyleTag({ content: `#editor, #editor * { font-family: "${font}" !important; }` });
    await page.locator('#editor th', { hasText: 'b' }).click();
    await page.keyboard.press('End');
    const steps: string[] = [];
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp']) {
      await page.keyboard.press(key);
      await frame(page);
      steps.push(await caret(page));
    }
    // Down the "b" column, out to "below"; back up into the first column, then out to "above".
    expect(steps).toEqual(['1:1@1,1', '1:1@2,1', '2:0', '1:1@2,0', '1:1@1,0', '1:1@0,0', '0:5']);
    await page.keyboard.type('!');
    expect(await blocks(page)).toEqual(['p:above!', 'table:a|b/c|d/e|f', 'p:below']);
  });
}

test('the caret stays in view while typing at the bottom of a scrolled editor', async ({ page }) => {
  await open(page, Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n\n'));
  const editor = page.locator('#editor');
  const inView = () =>
    page.evaluate(() => {
      const caret = (window as any).editor.selectionRect() as DOMRect;
      const box = document.getElementById('editor')!.getBoundingClientRect();
      return caret.top >= box.top && caret.bottom <= box.bottom;
    });
  await editor.locator('p').first().click();
  await page.keyboard.press('Control+End');
  await frame(page);
  expect(await inView()).toBe(true);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(`new ${i}`);
    await frame(page);
    expect(await inView()).toBe(true);
  }
  await page.keyboard.press('Control+Home');
  await frame(page);
  expect(await inView()).toBe(true);
  expect(await editor.evaluate((el) => el.scrollTop)).toBeLessThan(10);
  // Undo scrolls back to where the change was undone.
  await page.keyboard.press('Control+z');
  await frame(page);
  expect(await inView()).toBe(true);
});

test('mouse: double click selects a word and shows the toolbar', async ({ page }) => {
  await open(page, 'alpha beta gamma\n');
  await page.locator('#editor p').dblclick({ position: { x: 50, y: 8 } });
  await expect(page.locator('.mbe-toolbar')).toBeVisible();
  expect(await page.evaluate(() => document.getSelection()!.toString())).toBe('beta');
  await page.locator('.mbe-toolbar .mbe-tool-bold').click();
  expect(await md(page)).toBe('alpha **beta** gamma\n');
});

test('mouse: triple click selects one block, and typing replaces only that block', async ({ page }) => {
  await open(page, 'alpha beta gamma\n\nsecond\n\n- item one\n');
  await page.locator('#editor p').first().click({ clickCount: 3 });
  expect(await page.evaluate(() => document.getSelection()!.toString())).toBe('alpha beta gamma');
  await page.keyboard.type('X');
  expect(await blocks(page)).toEqual(['p:X', 'p:second', 'ul0:item one']);
  await page.locator('#editor .mbe-list-item').click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  expect(await blocks(page)).toEqual(['p:X', 'p:second', 'ul0:']);
});

/** The point on screen just before character `offset` of the `n`th paragraph's text. */
const pointAt = (page: Page, n: number, offset: number) =>
  page.evaluate(
    ([n, offset]) => {
      const text = document.querySelectorAll('#editor p')[n]!.firstChild!;
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      const r = range.getBoundingClientRect();
      return { x: r.left + 1, y: r.top + r.height / 2 };
    },
    [n, offset],
  );

test('mouse: dragging across blocks selects them, and Backspace joins what is left', async ({ page }) => {
  await open(page, 'first line\n\nsecond line\n\nthird line\n');
  const from = await pointAt(page, 0, 2);
  const to = await pointAt(page, 2, 2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => document.getSelection()!.toString())).toBe('rst line\n\nsecond line\n\nth');
  await expect(page.locator('.mbe-toolbar')).toBeVisible();
  await page.keyboard.press('Backspace');
  expect(await blocks(page)).toEqual(['p:fiird line']);
});
