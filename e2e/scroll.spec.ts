// commands.scrollIntoView: shows the caret after a change made from code,
// in the window and in a scrolling container.

import { expect, test, type Page } from '@playwright/test';

const LONG = Array.from({ length: 200 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n') + '\n';

/** Whether the caret's line is inside the window and inside the editor's own box. */
const caretVisible = (page: Page) =>
  page.evaluate(() => {
    const editor = (window as any).editor;
    const rect: DOMRect = editor.caretRect();
    const root: DOMRect = editor.root.getBoundingClientRect();
    return rect.top >= Math.max(0, root.top) && rect.bottom <= Math.min(innerHeight, root.bottom);
  });

test('scrollIntoView shows the caret in the window after an insert from code', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent(LONG)}`);
  await page.evaluate(() => {
    const editor = (window as any).editor;
    editor.commands.focus('end');
    editor.commands.insertMarkdown('Transcribed text.', { block: true });
  });
  expect(await caretVisible(page)).toBe(false);
  expect(await page.evaluate(() => (window as any).editor.commands.scrollIntoView())).toBe(true);
  expect(await caretVisible(page)).toBe(true);
  // Scrolling again does nothing: the caret is already shown.
  const y = await page.evaluate(() => scrollY);
  await page.evaluate(() => (window as any).editor.commands.scrollIntoView());
  expect(await page.evaluate(() => scrollY)).toBe(y);
});

test('scrollIntoView scrolls the editor when it is the scrolling container', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent(LONG)}`);
  await page.evaluate(() => {
    const editor = (window as any).editor;
    Object.assign(editor.root.style, { maxHeight: '200px', overflowY: 'auto' });
    editor.commands.focus('start');
    editor.root.scrollTop = 0;
    editor.setSelection({ anchor: { blockId: editor.state.doc.blocks[150].id, offset: 3 }, focus: { blockId: editor.state.doc.blocks[150].id, offset: 3 } });
    editor.root.scrollTop = 0;
    scrollTo(0, 0);
  });
  expect(await caretVisible(page)).toBe(false);
  await page.evaluate(() => (window as any).editor.commands.scrollIntoView());
  expect(await page.evaluate(() => (window as any).editor.root.scrollTop)).toBeGreaterThan(0);
  expect(await caretVisible(page)).toBe(true);
});
