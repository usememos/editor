// Where the suggestion popup goes: lined up with the trigger, under the
// caret's line, following scrolling and resizing, inside dialogs and
// transformed containers.

import { expect, test, type Page } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(() => {
    const { Editor, suggestion } = (window as any).core;
    (window as any).makeEditor = (element: HTMLElement, options: object = {}) => {
      (window as any).editor?.destroy();
      (window as any).editor = new Editor({
        element,
        ...options,
        extensions: [
          suggestion({
            name: 'tags',
            trigger: '#',
            className: 'tag-menu',
            items: () => ['work', 'reading', 'ideas'].map((t) => ({ id: t, label: `#${t}` })),
          }),
        ],
      });
    };
    (window as any).makeEditor(document.getElementById('editor'));
  });
});

const menu = (page: Page) => page.locator('.tag-menu');

/** The popup's rect, the trigger's rect and the caret's rect. The trigger is the last "#" before the caret. */
const rects = (page: Page) =>
  page.evaluate(() => {
    const editor = (window as any).editor;
    const pos = editor.state.selection.focus;
    const block = editor.state.doc.blocks.find((b: any) => b.id === pos.blockId);
    const text = block.content.map((s: any) => s.text).join('');
    const from = text.lastIndexOf('#', pos.offset - 1);
    const trigger = editor.textRect({ ...pos, offset: from }, { ...pos, offset: from + 1 }).rect;
    const caret = editor.caretRect();
    const popup = document.querySelector('.tag-menu')!.getBoundingClientRect();
    const plain = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    return { popup: plain(popup), trigger: plain(trigger), caret: plain(caret) };
  });

test('the popup lines up with the trigger, under the caret line, and does not move while typing', async ({ page }) => {
  await page.locator('#editor').click();
  await page.keyboard.type('Some text #');
  await expect(menu(page)).toBeVisible();
  const a = await rects(page);
  expect(Math.abs(a.popup.left - a.trigger.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(a.popup.top - (a.caret.bottom + 4))).toBeLessThanOrEqual(1);
  await page.keyboard.type('wor');
  const b = await rects(page);
  expect(b.popup.left).toBe(a.popup.left);
});

test('when the token wraps, the popup lines up with the caret', async ({ page }) => {
  await page.evaluate(() => {
    document.getElementById('editor')!.style.width = '160px';
  });
  await page.locator('#editor').click();
  await page.keyboard.type('Some words #averyveryverylongtagname');
  await expect(menu(page)).toBeVisible();
  const r = await rects(page);
  expect(r.trigger.top).toBeLessThan(r.caret.top);
  expect(Math.abs(r.popup.left - r.caret.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(r.popup.top - (r.caret.bottom + 4))).toBeLessThanOrEqual(1);
});

test('it follows scrolling and hides while the trigger is scrolled out of view', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setMarkdown(Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n\n')));
  await page.locator('#editor').click();
  await page.evaluate(() => (window as any).editor.setSelection({ anchor: { block: 1, offset: 6 }, focus: { block: 1, offset: 6 } }));
  await page.keyboard.type(' #');
  await expect(menu(page)).toBeVisible();
  const before = await rects(page);
  await page.locator('#editor').evaluate((el) => (el.scrollTop = 20));
  await expect.poll(async () => (await rects(page)).popup.top).toBeCloseTo(before.popup.top - 20, 0);
  await page.locator('#editor').evaluate((el) => (el.scrollTop = 2000));
  await expect(menu(page)).toBeHidden();
  await page.locator('#editor').evaluate((el) => (el.scrollTop = 0));
  await expect(menu(page)).toBeVisible();
  const after = await rects(page);
  expect(Math.abs(after.popup.left - after.trigger.left)).toBeLessThanOrEqual(1);
});

test('it follows a window resize', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.locator('#editor').click();
  await page.keyboard.type('x #');
  await expect(menu(page)).toBeVisible();
  const before = await rects(page);
  await page.setViewportSize({ width: 800, height: 700 });
  // The page is centered, so the trigger moved, and the popup with it.
  await expect.poll(async () => (await rects(page)).trigger.left).not.toBe(before.trigger.left);
  await expect.poll(async () => {
    const r = await rects(page);
    return Math.abs(r.popup.left - r.trigger.left) <= 1;
  }).toBe(true);
});

test('inside an open modal dialog, the popup is appended to the dialog', async ({ page }) => {
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = '<div id="in-dialog" style="width: 400px; min-height: 80px"></div>';
    document.body.appendChild(dialog);
    dialog.showModal();
    (window as any).makeEditor(document.getElementById('in-dialog'));
  });
  await page.locator('#in-dialog').click();
  await page.keyboard.type('x #');
  await expect(menu(page)).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('.tag-menu')!.parentElement!.tagName)).toBe('DIALOG');
  // It is not inert: a click picks an item.
  await page.locator('.tag-menu .mbe-menu-item', { hasText: '#reading' }).click();
  expect(await page.evaluate(() => (window as any).editor.getMarkdown())).toBe('x #reading&#32;\n');
});

test('in a transformed container given as popupContainer, the popup still lines up with the trigger', async ({ page }) => {
  await page.evaluate(() => {
    const wrap = document.createElement('div');
    wrap.id = 'wrap';
    wrap.style.cssText = 'position: absolute; left: 30px; top: 300px; transform: translate(40px, 20px); width: 400px';
    wrap.innerHTML = '<div id="moved" style="min-height: 60px"></div>';
    document.body.appendChild(wrap);
    (window as any).makeEditor(document.getElementById('moved'), { popupContainer: wrap });
  });
  await page.locator('#moved').click();
  await page.keyboard.type('hello #');
  await expect(menu(page)).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('.tag-menu')!.parentElement!.id)).toBe('wrap');
  const r = await rects(page);
  expect(Math.abs(r.popup.left - r.trigger.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(r.popup.top - (r.caret.bottom + 4))).toBeLessThanOrEqual(1);
});

test('in right-to-left text, the popup right edge lines up with the trigger right edge', async ({ page }) => {
  await page.locator('#editor').click();
  await page.keyboard.type('שלום #');
  await expect(menu(page)).toBeVisible();
  const r = await rects(page);
  expect(Math.abs(r.popup.right - r.trigger.right)).toBeLessThanOrEqual(1);
});

test('--mbe-popup-z sets the popup z-index', async ({ page }) => {
  await page.evaluate(() => document.getElementById('editor')!.style.setProperty('--mbe-popup-z', '5000'));
  await page.locator('#editor').click();
  await page.keyboard.type('#');
  await expect(menu(page)).toBeVisible();
  expect(await menu(page).evaluate((el) => getComputedStyle(el).zIndex)).toBe('5000');
});
