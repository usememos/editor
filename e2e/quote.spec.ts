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

test('a quote inside a quote, or a list the editor cannot hold, is one raw block in the quote; the rest of the quote stays blocks', async ({ page }) => {
  const doc = 'Before.\n\n> [!WARNING]\n> Run this first:\n> ```\n> rm -rf build\n> ```\n> > nested\n> - then this\n\n- Step\n\n  Second paragraph.\n';
  await page.goto(`/?md=${encodeURIComponent(doc)}`);
  expect(await blocks(page)).toEqual([
    'p:Before.',
    'warning:Run this first:',
    'warning/code():rm -rf build',
    'warning/raw(markdown):> nested',
    'warning/ul0:then this',
    'raw(markdown):- Step\n\n  Second paragraph.',
  ]);
  const raw = page.locator('#editor > .mbe-raw[data-syntax="markdown"]');
  await expect(raw).toHaveCount(2);
  // The nested quote is a blockquote of the callout, rendered with the editor's blocks, and the item holding two paragraphs a list item.
  await expect(raw.first()).toHaveClass(/mbe-view-block/);
  await expect(raw.first()).toHaveAttribute('data-callout', 'warning');
  await expect(raw.first().locator('.mbe-flow > blockquote')).toHaveText('nested');
  await expect(raw.nth(1).locator('.mbe-list-item p')).toHaveText(['Step', 'Second paragraph.']);
  await expect(page.locator('#editor')).not.toContainText('[!WARNING]');
  // The code block is a block of the document, in the callout.
  await expect(page.locator('#editor > blockquote.mbe-code[data-callout="warning"] code')).toHaveText('rm -rf build');
  // Nothing in a raw block is a block of the document.
  await expect(raw.first().locator('[data-block-id]')).toHaveCount(0);
  // A click shows the nested quote's source, without the outer quote's markers, as plain text to edit.
  await raw.first().click();
  await expect(page.locator('#editor > blockquote.mbe-raw[data-syntax="markdown"] > pre')).toHaveText('> nested');
  // Read-only always shows it rendered.
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  await expect(page.locator('#editor pre.mbe-raw')).toHaveCount(0);
  await expect(raw).toHaveCount(2);
  expect(await md(page)).toBe(doc);
});

// A web clipper's default template quotes the whole clip, so the quote holds a heading, a list, a table and code.
const CLIP = [
  '> ## Why room matters',
  '>',
  '> Leave a little room in your day. It is **easy** to fill every gap.',
  '>',
  '> - Walk before email',
  '> - Write one line',
  '>   - Even a bad one',
  '>',
  '> | Habit | Minutes |',
  '> | --- | --- |',
  '> | Walk | 20 |',
  '>',
  '> ```js',
  '> const room = plan.filter((slot) => !slot.busy);',
  '> ```',
  '',
  'A short summary.',
  '',
  '[A little room to think](https://fieldnotes.example/a-little-room)',
  '',
].join('\n');

test('a clipped page in a quote loads as blocks in the quote, with no raw block, and saves unchanged', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent(CLIP)}`);
  expect(await blocks(page)).toEqual([
    'quote/h2:Why room matters',
    'quote:Leave a little room in your day. It is easy to fill every gap.',
    'quote/ul0:Walk before email',
    'quote/ul0:Write one line',
    'quote/ul1:Even a bad one',
    'quote/table:Habit|Minutes/Walk|20',
    'quote/code(js):const room = plan.filter((slot) => !slot.busy);',
    'p:A short summary.',
    'p:A little room to think',
  ]);
  await expect(page.locator('#editor .mbe-raw')).toHaveCount(0);
  // One quote: every part is a blockquote, and the bar runs unbroken from the heading through the code.
  const parts = page.locator('#editor > blockquote');
  await expect(parts).toHaveCount(7);
  await expect(parts.first()).toHaveClass(/mbe-heading/);
  await expect(parts.first().locator('h2')).toHaveText('Why room matters');
  await expect(parts.nth(5)).toHaveClass(/mbe-table/);
  await expect(parts.last()).toHaveClass(/mbe-code/);
  const boxes = await parts.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom, left: r.left })));
  for (let i = 1; i < boxes.length; i++) {
    expect(Math.abs(boxes[i]!.top - boxes[i - 1]!.bottom)).toBeLessThan(1);
    expect(boxes[i]!.left).toBe(boxes[0]!.left);
  }
  // The heading is sized as a heading, and the code block keeps its panel inside the quote.
  const [h2Size, pSize] = await Promise.all([
    parts.first().locator('h2').evaluate((el) => getComputedStyle(el).fontSize),
    parts.nth(1).evaluate((el) => getComputedStyle(el).fontSize),
  ]);
  expect(Number.parseFloat(h2Size)).toBeGreaterThan(Number.parseFloat(pSize));
  const panel = parts.last().locator(':scope > .mbe-content');
  expect(await panel.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(await parts.last().evaluate((el) => getComputedStyle(el).backgroundColor));
  expect(await md(page)).toBe(CLIP);
  expect(await viewProblems(page)).toEqual([]);
});

test('editing inside a clipped quote keeps every block in the quote and saves the quote prefix on every line', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent(CLIP)}`);
  // Type at the end of the heading, then Enter: a new line of the quote, where "### " makes a heading in the quote.
  await page.locator('#editor > blockquote h2').click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Enter');
  await page.keyboard.type('### ');
  await page.keyboard.type('New line');
  expect((await blocks(page)).slice(0, 3)).toEqual(['quote/h2:Why room matters!', 'quote/h3:New line', 'quote:Leave a little room in your day. It is easy to fill every gap.']);
  // Backspace at the start of the heading makes it a paragraph of the quote again.
  await page.keyboard.press('ArrowLeft', { delay: 0 });
  for (let i = 0; i < 'New line'.length - 1; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Backspace');
  expect((await blocks(page)).slice(0, 3)).toEqual(['quote/h2:Why room matters!', 'quote:New line', 'quote:Leave a little room in your day. It is easy to fill every gap.']);
  // Typing at the end of the code block stays in the quote.
  await page.evaluate(() => {
    const editor = (window as any).editor;
    const code = editor.state.doc.blocks.find((b: any) => b.type === 'code');
    const end = { blockId: code.id, offset: code.content.map((s: any) => s.text).join('').length };
    editor.setSelection({ anchor: end, focus: end });
    editor.focus();
  });
  await page.keyboard.type(' // filter');
  const saved = await md(page);
  expect(saved).toBe(
    CLIP.replace('> ## Why room matters', '> ## Why room matters!\n>\n> New line').replace('!slot.busy);', '!slot.busy); // filter'),
  );
  expect(await viewProblems(page)).toEqual([]);
});

test('the toolbar quote button and the slash menu work on blocks in a quote', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent('> ## Title\n>\n> text\n')}`);
  // The quote button is pressed on a quoted heading; pressing it takes the heading out of the quote.
  const h2 = page.locator('#editor > blockquote h2');
  await h2.click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
  const quoteButton = page.locator('.mbe-toolbar .mbe-tool-quote');
  await expect(quoteButton).toHaveAttribute('aria-pressed', 'true');
  await quoteButton.click();
  expect(await blocks(page)).toEqual(['h2:Title', 'quote:text']);
  await quoteButton.click();
  expect(await blocks(page)).toEqual(['quote/h2:Title', 'quote:text']);
  // The slash menu's divider goes into the quote.
  await page.locator('#editor > blockquote.mbe-quote').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/div');
  await page.keyboard.press('Enter');
  expect(await blocks(page)).toEqual(['quote/h2:Title', 'quote:text', 'quote/hr', 'quote:']);
  expect(await md(page)).toBe('> ## Title\n>\n> text\n>\n> ---\n>\n> &nbsp;\n');
});
