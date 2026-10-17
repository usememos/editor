import { type Page, blocks, expect, md, test } from './helpers';

// Images come from a route the tests answer: an SVG of the size in its name
// (`/img/400x200.svg`), and a 404 for anything else.
test.beforeEach(async ({ page }) => {
  await page.route('**/img/**', (route) => {
    const size = /\/(\d+)x(\d+)\.svg$/.exec(new URL(route.request().url()).pathname);
    if (!size) return route.fulfill({ status: 404, body: '' });
    const [, w, h] = size;
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#88a"/></svg>`,
    });
  });
});

const open = async (page: Page, markdown: string) => {
  await page.goto(`/?md=${encodeURIComponent(markdown)}`);
  // Every image has loaded or failed.
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll<HTMLImageElement>('#editor img')).every((img) => img.complete && img.naturalWidth > 0),
  );
};

const image = (page: Page, n = 0) => page.locator('#editor img.mbe-image').nth(n);
const resizeHandle = (page: Page, side: 'left' | 'right') => page.locator(`.mbe-resize-handle-${side}`);

/** Drags a resize handle by `dx` pixels, in steps, as a mouse would. */
async function dragHandle(page: Page, side: 'left' | 'right', dx: number) {
  const box = (await resizeHandle(page, side).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x + (dx * i) / 5, y);
  await page.mouse.up();
}

test('a width after the alt text sizes the image and is saved as written', async ({ page }) => {
  await open(page, '![chart|120](/img/400x200.svg)\n');
  await expect(image(page)).toHaveAttribute('width', '120');
  expect((await image(page).boundingBox())!.width).toBeCloseTo(120, 0);
  expect(await md(page)).toBe('![chart|120](/img/400x200.svg)\n');
});

test('a width wider than the column is shown at the column width', async ({ page }) => {
  await open(page, '![chart|5000](/img/400x200.svg)\n');
  const content = (await page.locator('#editor .mbe-paragraph').boundingBox())!;
  expect((await image(page).boundingBox())!.width).toBeLessThanOrEqual(content.width + 1);
});

test('clicking an image selects it; Backspace deletes it', async ({ page }) => {
  await open(page, 'a ![chart](/img/400x200.svg) b\n');
  await image(page).click();
  expect(await page.evaluate(() => (window as any).editor.isActive('image'))).toBe(true);
  expect(await page.evaluate(() => (window as any).editor.getAttributes('image'))).toEqual({ src: '/img/400x200.svg', alt: 'chart', block: false });
  await expect(image(page)).toHaveClass(/mbe-image-selected/);
  // The formatting toolbar is for text.
  await expect(page.locator('.mbe-toolbar')).toBeHidden();
  await page.keyboard.press('Backspace');
  expect(await md(page)).toBe('a  b\n');
});

test('arrow keys leave a selected image; typing replaces it', async ({ page }) => {
  await open(page, 'a ![chart](/img/400x200.svg) b\n');
  await image(page).click();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('X');
  expect(await md(page)).toBe('a ![chart](/img/400x200.svg)X b\n');
  await image(page).click();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('Y');
  expect(await md(page)).toBe('a Y![chart](/img/400x200.svg)X b\n');
  await image(page).click();
  await page.keyboard.type('Z');
  expect(await md(page)).toBe('a YZX b\n');
});

test('Enter on a selected image starts a new paragraph after it', async ({ page }) => {
  await open(page, 'a ![chart](/img/400x200.svg) b\n');
  await image(page).click();
  await page.keyboard.press('Enter');
  await page.keyboard.type('next');
  expect(await blocks(page)).toEqual(['p:a ￼', 'p:next b']);
});

test('dragging a resize handle resizes the image as one undo step', async ({ page }) => {
  await open(page, '![chart](/img/400x200.svg)\n');
  await image(page).hover();
  await expect(resizeHandle(page, 'right')).toBeVisible();
  await dragHandle(page, 'right', -100);
  expect(await md(page)).toBe('![chart|300](/img/400x200.svg)\n');
  const box = (await image(page).boundingBox())!;
  expect(box.width).toBeCloseTo(300, 0);
  // The aspect ratio is kept.
  expect(box.height).toBeCloseTo(150, 0);
  // The resized image stays selected.
  expect(await page.evaluate(() => (window as any).editor.isActive('image'))).toBe(true);
  // The left resize handle grows the image when dragged to the left.
  await dragHandle(page, 'left', -50);
  expect(await md(page)).toBe('![chart|350](/img/400x200.svg)\n');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  expect(await md(page)).toBe('![chart|300](/img/400x200.svg)\n');
});

test('the resize handles stay inside a scrolling container shorter than the image', async ({ page }) => {
  // Text below the image, so the container can scroll the image out of view.
  const below = Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n') + '\n';
  await open(page, '![tall](/img/500x1400.svg)\n\n' + below);
  // The memos composer: a scrolling wrapper around the editor, shorter than the image.
  const card = page.locator('.card');
  await page.evaluate(() => {
    Object.assign(document.querySelector<HTMLElement>('#editor')!.style, { maxHeight: 'none', overflow: 'visible' });
    Object.assign(document.querySelector<HTMLElement>('.card')!.style, { maxHeight: '320px', overflowY: 'auto' });
  });
  const clientRect = () =>
    card.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { left: box.left + el.clientLeft, top: box.top + el.clientTop, right: box.left + el.clientLeft + el.clientWidth, bottom: box.top + el.clientTop + el.clientHeight };
    });
  const inside = async () => {
    const view = await clientRect();
    for (const side of ['left', 'right'] as const) {
      const box = (await resizeHandle(page, side).boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(view.top);
      expect(box.y + box.height).toBeLessThanOrEqual(view.bottom);
      expect(box.x).toBeGreaterThanOrEqual(view.left);
      expect(box.x + box.width).toBeLessThanOrEqual(view.right);
    }
  };
  let view = await clientRect();
  await page.mouse.move((view.left + view.right) / 2, (view.top + view.bottom) / 2);
  await expect(resizeHandle(page, 'right')).toBeVisible();
  await inside();
  // The image is taller than the container, so without clipping the handles would sit below it.
  expect((await image(page).boundingBox())!.height).toBeGreaterThan(view.bottom - view.top);
  // Scrolling the container keeps them inside.
  await card.evaluate((el) => (el.scrollTop = 500));
  await inside();
  // Scrolled out of view, the handles are hidden.
  await card.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(resizeHandle(page, 'right')).toBeHidden();
  await card.evaluate((el) => (el.scrollTop = 0));
  view = await clientRect();
  await page.mouse.move((view.left + view.right) / 2, (view.top + view.bottom) / 2);
  await expect(resizeHandle(page, 'right')).toBeVisible();
  // Resizing from the clipped frame still works on the image.
  await dragHandle(page, 'right', -100);
  expect(await md(page)).toBe('![tall|400](/img/500x1400.svg)\n\n' + below);
  expect((await image(page).boundingBox())!.width).toBeCloseTo(400, 0);
});

test('typing next to an image keeps its element, so it does not load again', async ({ page }) => {
  await open(page, 'a ![chart](/img/400x200.svg)\n');
  await image(page).evaluate((el) => ((el as any).marked = true));
  await page.locator('#editor .mbe-paragraph').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('Home');
  await page.keyboard.type('x');
  expect(await md(page)).toBe('xa ![chart](/img/400x200.svg)\n');
  expect(await image(page).evaluate((el) => (el as any).marked)).toBe(true);
  // Enter moves the image to a new block, and it keeps its element there too.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  expect(await blocks(page)).toEqual(['p:xa ', 'p:￼']);
  expect(await image(page).evaluate((el) => (el as any).marked)).toBe(true);
});

test('a resize snaps to the width of another image', async ({ page }) => {
  await open(page, '![a|200](/img/400x200.svg)\n\n![b](/img/400x200.svg)\n');
  await image(page, 1).hover();
  // 400 - 195 = 205, within 8px of the other image's 200.
  await dragHandle(page, 'right', -195);
  expect(await md(page)).toBe('![a|200](/img/400x200.svg)\n\n![b|200](/img/400x200.svg)\n');
});

test('a resize stops at the column width', async ({ page }) => {
  await open(page, '![chart|100](/img/2000x100.svg)\n');
  await image(page).hover();
  // Past the column, but inside the window: Firefox drops mouse events outside it.
  await dragHandle(page, 'right', 700);
  const content = (await page.locator('#editor .mbe-paragraph .mbe-content, #editor .mbe-paragraph').first().boundingBox())!;
  const width = Number(/\|(\d+)\]/.exec(await md(page))![1]);
  expect(width).toBeLessThanOrEqual(Math.ceil(content.width));
  expect(width).toBeGreaterThan(200);
});

test('a resize in a table cell is saved with an escaped pipe', async ({ page }) => {
  await open(page, '| a |\n| --- |\n| ![chart](/img/100x50.svg) |\n');
  await image(page).hover();
  await dragHandle(page, 'right', -40);
  expect(await md(page)).toBe('| a |\n| --- |\n| ![chart\\|60](/img/100x50.svg) |\n');
});

test('the selected outline is drawn inside the image', async ({ page }) => {
  await open(page, '![chart](/img/400x200.svg)\n');
  await image(page).click();
  expect(await image(page).evaluate((el) => getComputedStyle(el).outlineOffset)).toBe('-2px');
});

test('updateImage changes the selected image', async ({ page }) => {
  await open(page, '![chart|120x60](/img/400x200.svg)\n');
  await image(page).click();
  expect(await page.evaluate(() => (window as any).editor.commands.updateImage({ width: 200, title: 'Sales' }))).toBe(true);
  expect(await md(page)).toBe('![chart|200](/img/400x200.svg "Sales")\n');
  expect(await page.evaluate(() => (window as any).editor.commands.updateImage({ width: null }))).toBe(true);
  expect(await md(page)).toBe('![chart](/img/400x200.svg "Sales")\n');
});

test('an image that fails to load shows its alt text', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent('a ![Sales chart](/img/missing.png) b\n')}`);
  const box = page.locator('#editor .mbe-image-unavailable');
  await expect(box).toBeVisible();
  await expect(box).toHaveText('Sales chart');
  await expect(box).toHaveAttribute('aria-label', 'Sales chart');
  // It is still the image: it can be selected and deleted, and the Markdown is unchanged.
  expect(await md(page)).toBe('a ![Sales chart](/img/missing.png) b\n');
  await box.click();
  expect(await page.evaluate(() => (window as any).editor.isActive('image'))).toBe(true);
  await expect(resizeHandle(page, 'right')).toBeHidden();
  await page.keyboard.press('Backspace');
  expect(await md(page)).toBe('a  b\n');
});

test('an image with no alt text that fails to load says so', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent('![](/img/missing.png)\n')}`);
  await expect(page.locator('#editor .mbe-image-unavailable')).toHaveText('Image unavailable');
});

test('read-only: no selection or handles on images', async ({ page }) => {
  await open(page, '![chart](/img/400x200.svg)\n');
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  await image(page).hover();
  await expect(resizeHandle(page, 'right')).toBeHidden();
  await image(page).click();
  expect(await page.evaluate(() => (window as any).editor.isActive('image'))).toBe(false);
});

const menuItem = (page: Page, text: string) => page.locator('.mbe-block-menu .mbe-menu-item', { hasText: text });
const subItem = (page: Page, text: string) => page.locator('.mbe-submenu .mbe-menu-item', { hasText: text });

test('an image alone in its paragraph is an image block with a block handle and a block menu', async ({ page }) => {
  await open(page, '![chart|200](/img/400x200.svg)\n\na ![inline](/img/100x50.svg) b\n');
  await expect(page.locator('#editor .mbe-image-block')).toHaveCount(1);
  await image(page).hover();
  await expect(page.locator('.mbe-block-handle')).toBeVisible();
  await page.locator('.mbe-block-handle').click();
  await expect(page.locator('.mbe-block-menu')).toBeVisible();
  // Opening the menu selects the image.
  expect(await page.evaluate(() => (window as any).editor.getAttributes('image').block)).toBe(true);
  await expect(menuItem(page, 'Align')).toBeVisible();
  await expect(menuItem(page, 'Reset size')).toBeVisible();
  await page.keyboard.press('Escape');
  // An image inside text has no block menu.
  await image(page, 1).hover();
  await expect(page.locator('.mbe-block-handle')).toBeHidden();
});

test('the Align submenu aligns an image block and saves it after the alt text', async ({ page }) => {
  await open(page, '![chart|200](/img/400x200.svg)\n');
  const column = (await page.locator('#editor .mbe-image-block').boundingBox())!;
  await image(page).click();
  await page.keyboard.press('Control+/');
  await menuItem(page, 'Align').hover();
  await expect(page.locator('.mbe-submenu')).toBeVisible();
  // The current alignment is checked.
  await expect(subItem(page, 'Left')).toHaveAttribute('aria-checked', 'true');
  await subItem(page, 'Center').click();
  expect(await md(page)).toBe('![chart|center|200](/img/400x200.svg)\n');
  await expect(page.locator('.mbe-block-menu')).toBeHidden();
  let box = (await image(page).boundingBox())!;
  expect(box.x + box.width / 2).toBeCloseTo(column.x + column.width / 2, 0);
  // From the keyboard: ArrowRight opens the submenu, Enter picks.
  await page.keyboard.press('Control+/');
  await page.keyboard.press('ArrowDown');
  while (!(await menuItem(page, 'Align').evaluate((el) => el.classList.contains('mbe-highlighted')))) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(subItem(page, 'Center')).toHaveClass(/mbe-highlighted/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  expect(await md(page)).toBe('![chart|right|200](/img/400x200.svg)\n');
  box = (await image(page).boundingBox())!;
  expect(box.x + box.width).toBeCloseTo(column.x + column.width, 0);
  // ArrowLeft closes only the submenu; Escape then closes the menu.
  await page.keyboard.press('Control+/');
  await menuItem(page, 'Align').hover();
  await expect(page.locator('.mbe-submenu')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.mbe-submenu')).toBeHidden();
  await expect(page.locator('.mbe-block-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.mbe-block-menu')).toBeHidden();
  // Left removes the word, and the change is one undo step.
  await page.keyboard.press('Control+/');
  await menuItem(page, 'Align').hover();
  await subItem(page, 'Left').click();
  expect(await md(page)).toBe('![chart|200](/img/400x200.svg)\n');
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('![chart|right|200](/img/400x200.svg)\n');
});

test('the submenu opens on the left when there is no room on the right', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 600 });
  await open(page, '![chart|100](/img/400x200.svg)\n');
  await image(page).click();
  await page.keyboard.press('Control+/');
  await menuItem(page, 'Align').hover();
  const menu = (await page.locator('.mbe-block-menu').boundingBox())!;
  const sub = (await page.locator('.mbe-submenu').boundingBox())!;
  expect(sub.x >= menu.x + menu.width - 1 || sub.x + sub.width <= menu.x + 1).toBe(true);
  expect(sub.x).toBeGreaterThanOrEqual(0);
  expect(sub.x + sub.width).toBeLessThanOrEqual(420);
});

test('Reset size removes the width of an image block', async ({ page }) => {
  await open(page, '![chart|center|200](/img/400x200.svg)\n');
  await image(page).click();
  await page.keyboard.press('Control+/');
  await menuItem(page, 'Reset size').click();
  expect(await md(page)).toBe('![chart|center](/img/400x200.svg)\n');
  // Without a width there is nothing to reset.
  await page.keyboard.press('Control+/');
  await expect(menuItem(page, 'Reset size')).toHaveCount(0);
});

test('Alt text edits the alt text of an image block and keeps its alignment and size', async ({ page }) => {
  await open(page, '![chart|center|200](/img/400x200.svg)\n');
  await image(page).click();
  await page.keyboard.press('Control+/');
  await menuItem(page, 'Alt text').click();
  const input = page.locator('.mbe-popover-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('chart');
  await expect(input).toHaveAttribute('aria-label', 'Alt text');
  // Escape keeps the old text and the image selected.
  await page.keyboard.type('Sales');
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
  expect(await md(page)).toBe('![chart|center|200](/img/400x200.svg)\n');
  expect(await page.evaluate(() => (window as any).editor.getAttributes('image').block)).toBe(true);
  // Enter saves it as one undo step, and the image stays selected.
  await page.keyboard.press('Control+/');
  await menuItem(page, 'Alt text').click();
  await page.keyboard.type('Sales by month');
  await page.keyboard.press('Enter');
  expect(await md(page)).toBe('![Sales by month|center|200](/img/400x200.svg)\n');
  await expect(image(page)).toHaveAttribute('alt', 'Sales by month');
  expect(await page.evaluate(() => (window as any).editor.getAttributes('image').block)).toBe(true);
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('![chart|center|200](/img/400x200.svg)\n');
  // Empty alt text is allowed.
  await page.keyboard.press('Control+/');
  await menuItem(page, 'Alt text').click();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Enter');
  expect(await md(page)).toBe('![|center|200](/img/400x200.svg)\n');
});

test('arrow keys step onto an image block, and Backspace selects it before deleting it', async ({ page }) => {
  await open(page, 'above\n\n![chart](/img/400x200.svg)\n\nbelow\n');
  await page.locator('#editor p', { hasText: 'above' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => (window as any).editor.getAttributes('image').block)).toBe(true);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('!');
  expect(await md(page)).toBe('above\n\n![chart](/img/400x200.svg)\n\n!below\n');
  // Backspace at the start of the next block selects the image first.
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  expect(await page.evaluate(() => (window as any).editor.getAttributes('image').block)).toBe(true);
  expect(await md(page)).toBe('above\n\n![chart](/img/400x200.svg)\n\n!below\n');
  // Printable keys do not replace an image block.
  await page.keyboard.type('x');
  expect(await md(page)).toBe('above\n\n![chart](/img/400x200.svg)\n\n!below\n');
  await page.keyboard.press('Backspace');
  expect(await md(page)).toBe('above\n\n!below\n');
});

test('a centered image grows by twice the drag, so the resize handle stays under the mouse', async ({ page }) => {
  await open(page, '![chart|center|200](/img/400x200.svg)\n');
  await image(page).hover();
  await dragHandle(page, 'right', 50);
  expect(await md(page)).toBe('![chart|center|300](/img/400x200.svg)\n');
});

test('read-only: an aligned image is shown aligned', async ({ page }) => {
  await open(page, '![chart|right|100](/img/400x200.svg)\n');
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  const column = (await page.locator('#editor .mbe-image-block').boundingBox())!;
  const box = (await image(page).boundingBox())!;
  expect(box.x + box.width).toBeCloseTo(column.x + column.width, 0);
});

test('an aligned image stays aligned under a reset that makes images blocks', async ({ page }) => {
  await open(page, '![chart|center|100](/img/400x200.svg)\n');
  // Tailwind's preflight, for one.
  await page.addStyleTag({ content: 'img { display: block; }' });
  const column = (await page.locator('#editor .mbe-image-block').boundingBox())!;
  const box = (await image(page).boundingBox())!;
  expect(box.x + box.width / 2).toBeCloseTo(column.x + column.width / 2, 0);
});

test('an image block lays out the same before and after it renders again while editing', async ({ page }) => {
  await open(page, 'above\n\n![chart](/img/400x200.svg)\n\nbelow\n');
  // A host style that makes the image a block, so its margins could merge with the block's.
  await page.addStyleTag({ content: '#editor .mbe-image { display: block !important; }' });
  const layout = () =>
    page.evaluate(() => {
      const top = (el: Element) => el.getBoundingClientRect().top;
      const blocks = document.querySelectorAll('#editor .mbe-block');
      return [top(document.querySelector('#editor img')!) - top(blocks[0]), top(blocks[2]) - top(blocks[0])];
    });
  // A loaded document's blocks are lazy; blocks rendered while editing are not.
  expect(await page.locator('#editor .mbe-image-block.mbe-lazy').count()).toBe(1);
  const loaded = await layout();
  await page.evaluate(() => document.querySelector('#editor .mbe-image-block')!.classList.remove('mbe-lazy'));
  expect(await layout()).toEqual(loaded);
});
